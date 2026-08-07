//! PumpBrokers — mint / sell-back program.
//!
//! Economics: mint costs `mint_price`, sell-back returns `redeem_price`, and
//! `redeem_price < mint_price`. Every mint therefore adds
//! `mint_price - redeem_price` of headroom to the treasury while creating one
//! obligation worth `redeem_price`, so the invariant
//!
//!     treasury >= circulating * redeem_price
//!
//! strengthens monotonically under normal operation. `redeem` refuses to pay
//! when the treasury is short, and `withdraw_surplus` cannot touch reserved
//! funds, so the floor is structural rather than a promise.
//!
//! Redeemed assets are transferred to the vault PDA and re-sold by
//! `mint_recycled`, so supply stays at `supply_cap` and the art circulates.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use mpl_core::instructions::{CreateV2CpiBuilder, TransferV1CpiBuilder};
use mpl_core::types::{DataState, UpdateAuthority};

pub mod errors;
pub mod state;

use errors::PumpBrokersError;
use state::*;

// Deterministic placeholder so the crate compiles and tests can run. Replace
// with the real keypair's pubkey via `anchor keys sync` before any deploy —
// see MAINNET_CHECKLIST.md step 2.
declare_id!("AZxi6H7EcVRo23zyVmET74m8mPWBGKkPaexsdMq68MNU");

#[program]
pub mod pumpbrokers {
    use super::*;

    /// One-time setup. Prices arrive already scaled to base units by the caller
    /// (from `config/`), so the program never does decimal maths.
    pub fn initialize(
        ctx: Context<Initialize>,
        mint_price: u64,
        redeem_price: u64,
        supply_cap: u16,
        base_uri: String,
    ) -> Result<()> {
        require!(
            mint_price > 0 && redeem_price > 0 && redeem_price < mint_price,
            PumpBrokersError::InvalidPrices
        );
        require!(
            supply_cap > 0 && supply_cap <= MAX_SUPPLY,
            PumpBrokersError::InvalidSupplyCap
        );

        let uri_bytes = base_uri.as_bytes();
        require!(
            !uri_bytes.is_empty() && uri_bytes.len() <= BASE_URI_BYTES,
            PumpBrokersError::InvalidBaseUri
        );
        // A base that does not end in '/' would silently produce
        // ".../manifest123.json" instead of ".../manifest/123.json".
        require!(
            base_uri.ends_with('/'),
            PumpBrokersError::InvalidBaseUri
        );

        let cfg = &mut ctx.accounts.config;
        cfg.authority = ctx.accounts.authority.key();
        cfg.token_mint = ctx.accounts.token_mint.key();
        cfg.collection = ctx.accounts.collection.key();
        cfg.treasury = ctx.accounts.treasury.key();
        cfg.mint_price = mint_price;
        cfg.redeem_price = redeem_price;
        cfg.supply_cap = supply_cap;
        cfg.minted_count = 0;
        cfg.circulating = 0;
        cfg.paused_mint = false;
        cfg.paused_redeem = false;
        cfg.phase = Phase::Closed as u8;
        cfg.vault_bump = ctx.bumps.vault;
        cfg.bump = ctx.bumps.config;
        cfg.bitmap = [0u8; BITMAP_BYTES];
        cfg.base_uri = [0u8; BASE_URI_BYTES];
        cfg.base_uri[..uri_bytes.len()].copy_from_slice(uri_bytes);
        cfg.base_uri_len = uri_bytes.len() as u8;

        Ok(())
    }

    /// Mint a fresh PumpBroker. The buyer pays the asset's own rent, which is
    /// why we never pre-mint 1,000 assets (PLAN.md §1.2).
    pub fn mint_new(ctx: Context<MintNew>) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(!cfg.paused_mint, PumpBrokersError::MintPaused);
        require!(
            Phase::from_u8(cfg.phase)? == Phase::Public,
            PumpBrokersError::PhaseClosed
        );
        require!(
            cfg.minted_count < cfg.supply_cap,
            PumpBrokersError::SoldOut
        );

        // Choose the index before mutating anything.
        let index = cfg.pick_unminted(entropy_seed(
            &ctx.accounts.buyer.key(),
            cfg.minted_count,
        )?)?;
        let uri = cfg.asset_uri(index)?;
        let name = cfg.asset_name(index);

        // Payment first: if the buyer cannot pay, nothing else has happened.
        take_payment(
            &ctx.accounts.token_program,
            &ctx.accounts.buyer_token_account,
            &ctx.accounts.treasury,
            &ctx.accounts.token_mint,
            &ctx.accounts.buyer,
            cfg.mint_price,
        )?;

        let vault_bump = cfg.vault_bump;
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, &[vault_bump]];

        CreateV2CpiBuilder::new(&ctx.accounts.mpl_core_program)
            .asset(&ctx.accounts.asset)
            .collection(Some(&ctx.accounts.collection))
            // The vault PDA is the collection's update authority, so it has to
            // sign for the asset to join the collection.
            .authority(Some(&ctx.accounts.vault))
            .payer(&ctx.accounts.buyer)
            .owner(Some(&ctx.accounts.buyer.to_account_info()))
            .system_program(&ctx.accounts.system_program)
            .data_state(DataState::AccountState)
            .name(name)
            .uri(uri)
            .invoke_signed(&[vault_seeds])?;

        let cfg = &mut ctx.accounts.config;
        cfg.mark_minted(index)?;
        cfg.minted_count = cfg
            .minted_count
            .checked_add(1)
            .ok_or_else(|| error!(PumpBrokersError::MathOverflow))?;
        cfg.circulating = cfg
            .circulating
            .checked_add(1)
            .ok_or_else(|| error!(PumpBrokersError::MathOverflow))?;

        emit!(Minted {
            buyer: ctx.accounts.buyer.key(),
            asset: ctx.accounts.asset.key(),
            index,
            price: cfg.mint_price,
            recycled: false,
        });
        Ok(())
    }

    /// Re-sell a PumpBroker that a previous holder sold back. Cheaper for the
    /// buyer than `mint_new` — the asset account already exists, so there is no
    /// new rent to pay.
    pub fn mint_recycled(ctx: Context<MintRecycled>) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(!cfg.paused_mint, PumpBrokersError::MintPaused);
        require!(
            Phase::from_u8(cfg.phase)? == Phase::Public,
            PumpBrokersError::PhaseClosed
        );

        // The pool is "assets the vault happens to own" — no on-chain list.
        // Verifying ownership here is what makes that safe, and is also what
        // makes two buyers racing for the same asset resolve cleanly: the
        // loser fails this check rather than double-spending it.
        let asset = read_asset(&ctx.accounts.asset)?;
        require_keys_eq!(
            asset.owner,
            ctx.accounts.vault.key(),
            PumpBrokersError::AssetNotInVault
        );
        require_collection(&asset.update_authority, &cfg.collection)?;

        take_payment(
            &ctx.accounts.token_program,
            &ctx.accounts.buyer_token_account,
            &ctx.accounts.treasury,
            &ctx.accounts.token_mint,
            &ctx.accounts.buyer,
            cfg.mint_price,
        )?;

        let vault_bump = cfg.vault_bump;
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, &[vault_bump]];

        TransferV1CpiBuilder::new(&ctx.accounts.mpl_core_program)
            .asset(&ctx.accounts.asset)
            .collection(Some(&ctx.accounts.collection))
            .payer(&ctx.accounts.buyer)
            .authority(Some(&ctx.accounts.vault))
            .new_owner(&ctx.accounts.buyer.to_account_info())
            .system_program(Some(&ctx.accounts.system_program))
            .invoke_signed(&[vault_seeds])?;

        let cfg = &mut ctx.accounts.config;
        // minted_count is deliberately NOT incremented: this asset was already
        // counted when it was created. Incrementing here would let redeem/mint
        // cycles inflate the count past the cap.
        cfg.circulating = cfg
            .circulating
            .checked_add(1)
            .ok_or_else(|| error!(PumpBrokersError::MathOverflow))?;

        emit!(Minted {
            buyer: ctx.accounts.buyer.key(),
            asset: ctx.accounts.asset.key(),
            index: 0,
            price: cfg.mint_price,
            recycled: true,
        });
        Ok(())
    }

    /// Sell a PumpBroker back for `redeem_price`. The floor mechanic.
    pub fn redeem(ctx: Context<Redeem>) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(!cfg.paused_redeem, PumpBrokersError::RedeemPaused);

        let asset = read_asset(&ctx.accounts.asset)?;
        require_keys_eq!(
            asset.owner,
            ctx.accounts.holder.key(),
            PumpBrokersError::NotAssetOwner
        );
        require_collection(&asset.update_authority, &cfg.collection)?;

        // Fail cleanly and readably rather than underflowing. This is the check
        // the site's "redemptions available: N" figure mirrors.
        require!(
            ctx.accounts.treasury.amount >= cfg.redeem_price,
            PumpBrokersError::InsufficientTreasury
        );

        // Asset moves in before tokens move out.
        TransferV1CpiBuilder::new(&ctx.accounts.mpl_core_program)
            .asset(&ctx.accounts.asset)
            .collection(Some(&ctx.accounts.collection))
            .payer(&ctx.accounts.holder)
            .authority(Some(&ctx.accounts.holder.to_account_info()))
            .new_owner(&ctx.accounts.vault)
            .system_program(Some(&ctx.accounts.system_program))
            .invoke()?;

        let vault_bump = cfg.vault_bump;
        let redeem_price = cfg.redeem_price;
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, &[vault_bump]];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.treasury.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.holder_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            redeem_price,
            ctx.accounts.token_mint.decimals,
        )?;

        let cfg = &mut ctx.accounts.config;
        cfg.circulating = cfg
            .circulating
            .checked_sub(1)
            .ok_or_else(|| error!(PumpBrokersError::MathOverflow))?;

        emit!(Redeemed {
            holder: ctx.accounts.holder.key(),
            asset: ctx.accounts.asset.key(),
            payout: redeem_price,
        });
        Ok(())
    }

    /// Emergency stop. Mint and sell-back pause independently — pausing mint
    /// while leaving sell-back live is the right response to most incidents,
    /// since it stops new obligations without trapping existing holders.
    pub fn set_paused(
        ctx: Context<AdminOnly>,
        paused_mint: bool,
        paused_redeem: bool,
    ) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.paused_mint = paused_mint;
        cfg.paused_redeem = paused_redeem;
        emit!(PauseChanged {
            paused_mint,
            paused_redeem
        });
        Ok(())
    }

    pub fn set_phase(ctx: Context<AdminOnly>, phase: u8) -> Result<()> {
        let parsed = Phase::from_u8(phase)?;
        ctx.accounts.config.phase = parsed as u8;
        Ok(())
    }

    /// Withdraw treasury surplus — the accumulated spread, plus anything sent
    /// in from creator-fee claims.
    ///
    /// Hard-capped at `treasury - circulating * redeem_price`. The admin cannot
    /// withdraw the money backing outstanding sell-backs, so "the floor holds"
    /// does not depend on the admin behaving.
    pub fn withdraw_surplus(ctx: Context<WithdrawSurplus>, amount: u64) -> Result<()> {
        let cfg = &ctx.accounts.config;
        let reserved = cfg.reserved()?;
        let balance = ctx.accounts.treasury.amount;
        let surplus = balance.saturating_sub(reserved);
        require!(amount <= surplus, PumpBrokersError::WouldBreakFloor);

        let vault_bump = cfg.vault_bump;
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, &[vault_bump]];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.treasury.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            amount,
            ctx.accounts.token_mint.decimals,
        )?;

        emit!(SurplusWithdrawn { amount, reserved });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Weak on-chain entropy for index selection. See PLAN.md §4 — a caller who can
/// simulate and time a transaction can bias this. Deliberately does not accept
/// caller-supplied entropy, which would make it trivially chosen.
fn entropy_seed(buyer: &Pubkey, minted_count: u16) -> Result<u16> {
    let clock = Clock::get()?;
    let mut data = Vec::with_capacity(32 + 8 + 8 + 2);
    data.extend_from_slice(buyer.as_ref());
    data.extend_from_slice(&clock.slot.to_le_bytes());
    data.extend_from_slice(&clock.unix_timestamp.to_le_bytes());
    data.extend_from_slice(&minted_count.to_le_bytes());
    let digest = hash(&data);
    let bytes = digest.to_bytes();
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_asset(asset: &UncheckedAccount) -> Result<mpl_core::accounts::BaseAssetV1> {
    require_keys_eq!(
        *asset.owner,
        mpl_core::ID,
        PumpBrokersError::InvalidAssetAccount
    );
    let data = asset.try_borrow_data()?;
    mpl_core::accounts::BaseAssetV1::from_bytes(&data)
        .map_err(|_| error!(PumpBrokersError::InvalidAssetAccount))
}

/// An asset counts as ours only if its update authority IS our collection.
/// Anyone can create a Core asset named "PumpBroker #7"; only assets whose
/// update authority is our collection are redeemable for real tokens.
fn require_collection(update_authority: &UpdateAuthority, collection: &Pubkey) -> Result<()> {
    match update_authority {
        UpdateAuthority::Collection(c) if c == collection => Ok(()),
        _ => err!(PumpBrokersError::WrongCollection),
    }
}

fn take_payment<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    buyer: &Signer<'info>,
    amount: u64,
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new(
            token_program.to_account_info(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: buyer.to_account_info(),
            },
        ),
        amount,
        mint.decimals,
    )
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = Config::LEN,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,

    /// CHECK: PDA with no data; holds the treasury and recycled assets.
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault: UncheckedAccount<'info>,

    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        constraint = treasury.mint == token_mint.key() @ PumpBrokersError::TreasuryMismatch,
        constraint = treasury.owner == vault.key() @ PumpBrokersError::TreasuryMismatch,
    )]
    pub treasury: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: verified as an mpl-core account by the collection constraint below.
    #[account(owner = mpl_core::ID @ PumpBrokersError::WrongCollection)]
    pub collection: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintNew<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// CHECK: signing PDA, verified by seeds.
    #[account(mut, seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: fresh keypair for the new Core asset; mpl-core validates it.
    #[account(mut, signer)]
    pub asset: UncheckedAccount<'info>,

    /// CHECK: must be the collection recorded at initialize.
    #[account(mut, address = config.collection @ PumpBrokersError::WrongCollection)]
    pub collection: UncheckedAccount<'info>,

    #[account(address = config.token_mint)]
    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = buyer_token_account.mint == config.token_mint,
        constraint = buyer_token_account.owner == buyer.key(),
    )]
    pub buyer_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, address = config.treasury @ PumpBrokersError::TreasuryMismatch)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: address-checked against the known Core program.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintRecycled<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// CHECK: signing PDA, verified by seeds.
    #[account(mut, seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: ownership and collection verified in the handler.
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,

    /// CHECK: must be the collection recorded at initialize.
    #[account(mut, address = config.collection @ PumpBrokersError::WrongCollection)]
    pub collection: UncheckedAccount<'info>,

    #[account(address = config.token_mint)]
    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = buyer_token_account.mint == config.token_mint,
        constraint = buyer_token_account.owner == buyer.key(),
    )]
    pub buyer_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, address = config.treasury @ PumpBrokersError::TreasuryMismatch)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: address-checked against the known Core program.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// CHECK: signing PDA, verified by seeds. Receives the asset.
    #[account(mut, seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: ownership and collection verified in the handler.
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,

    /// CHECK: must be the collection recorded at initialize.
    #[account(mut, address = config.collection @ PumpBrokersError::WrongCollection)]
    pub collection: UncheckedAccount<'info>,

    #[account(address = config.token_mint)]
    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = holder_token_account.mint == config.token_mint,
        constraint = holder_token_account.owner == holder.key(),
    )]
    pub holder_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, address = config.treasury @ PumpBrokersError::TreasuryMismatch)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: address-checked against the known Core program.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(address = config.authority)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct WithdrawSurplus<'info> {
    #[account(address = config.authority)]
    pub authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// CHECK: signing PDA, verified by seeds.
    #[account(seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,

    #[account(address = config.token_mint)]
    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, address = config.treasury @ PumpBrokersError::TreasuryMismatch)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, constraint = destination.mint == config.token_mint)]
    pub destination: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

// ---------------------------------------------------------------------------
// Events — the airdrop record page and mint feed read these.
// ---------------------------------------------------------------------------

#[event]
pub struct Minted {
    pub buyer: Pubkey,
    pub asset: Pubkey,
    /// Meaningful only when `recycled` is false.
    pub index: u16,
    pub price: u64,
    pub recycled: bool,
}

#[event]
pub struct Redeemed {
    pub holder: Pubkey,
    pub asset: Pubkey,
    pub payout: u64,
}

#[event]
pub struct PauseChanged {
    pub paused_mint: bool,
    pub paused_redeem: bool,
}

#[event]
pub struct SurplusWithdrawn {
    pub amount: u64,
    pub reserved: u64,
}
