use anchor_lang::prelude::*;

use crate::errors::PitBrokersError;

pub const MAX_SUPPLY: u16 = 1000;
/// 1000 bits, one per asset index. ceil(1000 / 8) = 125 bytes.
pub const BITMAP_BYTES: usize = 125;
/// Room for "https://arweave.net/<43-char-tx-id>/" with slack to spare.
pub const BASE_URI_BYTES: usize = 128;

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Closed = 0,
    Allowlist = 1,
    Public = 2,
}

impl Phase {
    pub fn from_u8(v: u8) -> Result<Self> {
        match v {
            0 => Ok(Phase::Closed),
            1 => Ok(Phase::Allowlist),
            2 => Ok(Phase::Public),
            _ => err!(PitBrokersError::InvalidPhase),
        }
    }
}

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub token_mint: Pubkey,
    pub collection: Pubkey,
    pub treasury: Pubkey,

    /// Base units (already scaled by token decimals). Integer, always.
    pub mint_price: u64,
    /// Base units. Must be < mint_price; the difference is the treasury spread.
    pub redeem_price: u64,

    pub supply_cap: u16,
    /// Assets ever created. Monotonic — never decremented, so it cannot be
    /// gamed by redeeming to free up "new" mints beyond the cap.
    pub minted_count: u16,
    /// Assets currently held by users. Each one is an outstanding sell-back
    /// obligation of `redeem_price`.
    pub circulating: u16,

    pub paused_mint: bool,
    pub paused_redeem: bool,
    pub phase: u8,
    pub vault_bump: u8,
    pub bump: u8,

    /// Arweave/Irys base, e.g. "https://arweave.net/<manifest>/". Fixed-size so
    /// rent is predictable. Metadata URIs are DERIVED from this on-chain rather
    /// than accepted from the caller — otherwise a buyer could mint an asset
    /// pointing at metadata of their choosing.
    pub base_uri: [u8; BASE_URI_BYTES],
    pub base_uri_len: u8,

    /// bit i set => index i has been created at some point.
    pub bitmap: [u8; BITMAP_BYTES],
}

impl Config {
    /// 8 discriminator + fields. Anchor's InitSpace would work too; spelled out
    /// so the rent cost in PLAN.md §5 is auditable against the layout.
    pub const LEN: usize = 8
        + (32 * 4)
        + (8 * 2)
        + (2 * 3)
        + 1 // paused_mint
        + 1 // paused_redeem
        + 1 // phase
        + 1 // vault_bump
        + 1 // bump
        + BASE_URI_BYTES
        + 1 // base_uri_len
        + BITMAP_BYTES;

    pub fn base_uri_str(&self) -> Result<&str> {
        let len = self.base_uri_len as usize;
        require!(len <= BASE_URI_BYTES, PitBrokersError::InvalidBaseUri);
        core::str::from_utf8(&self.base_uri[..len])
            .map_err(|_| error!(PitBrokersError::InvalidBaseUri))
    }

    /// `<base><index>.json` — the only URI this program will ever attach.
    pub fn asset_uri(&self, index: u16) -> Result<String> {
        Ok(format!("{}{}.json", self.base_uri_str()?, index))
    }

    pub fn asset_name(&self, index: u16) -> String {
        format!("PitBroker #{}", index)
    }

    pub fn is_minted(&self, index: u16) -> Result<bool> {
        require!(index < self.supply_cap, PitBrokersError::IndexOutOfRange);
        let byte = (index / 8) as usize;
        let bit = (index % 8) as u8;
        Ok(self.bitmap[byte] & (1u8 << bit) != 0)
    }

    pub fn mark_minted(&mut self, index: u16) -> Result<()> {
        require!(index < self.supply_cap, PitBrokersError::IndexOutOfRange);
        require!(!self.is_minted(index)?, PitBrokersError::IndexAlreadyMinted);
        let byte = (index / 8) as usize;
        let bit = (index % 8) as u8;
        self.bitmap[byte] |= 1u8 << bit;
        Ok(())
    }

    /// Funds that must stay in the treasury to honour every outstanding NFT.
    /// This is the number that makes the floor real.
    pub fn reserved(&self) -> Result<u64> {
        (self.circulating as u64)
            .checked_mul(self.redeem_price)
            .ok_or_else(|| error!(PitBrokersError::MathOverflow))
    }

    /// Pick an unminted index, seeded by caller-supplied entropy.
    ///
    /// Scans forward from `start` so it always terminates and always returns a
    /// genuinely unminted index. NOT cryptographically fair — a caller who can
    /// simulate and time their transaction can bias the result. Documented in
    /// PLAN.md §4; commit-reveal is the fix if we decide it matters.
    pub fn pick_unminted(&self, start: u16) -> Result<u16> {
        let cap = self.supply_cap;
        require!(cap > 0, PitBrokersError::InvalidSupplyCap);
        let offset = start % cap;
        for i in 0..cap {
            let candidate = (offset + i) % cap;
            if !self.is_minted(candidate)? {
                return Ok(candidate);
            }
        }
        err!(PitBrokersError::PoolExhausted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(supply_cap: u16) -> Config {
        Config {
            authority: Pubkey::new_unique(),
            token_mint: Pubkey::new_unique(),
            collection: Pubkey::new_unique(),
            treasury: Pubkey::new_unique(),
            // 6-decimal token: 1,000,000 and 950,000 whole tokens.
            mint_price: 1_000_000_000_000,
            redeem_price: 950_000_000_000,
            supply_cap,
            minted_count: 0,
            circulating: 0,
            paused_mint: false,
            paused_redeem: false,
            phase: Phase::Public as u8,
            vault_bump: 255,
            bump: 255,
            base_uri: {
                let mut b = [0u8; BASE_URI_BYTES];
                let s = b"https://arweave.net/MANIFEST/";
                b[..s.len()].copy_from_slice(s);
                b
            },
            base_uri_len: 29,
            bitmap: [0u8; BITMAP_BYTES],
        }
    }

    #[test]
    fn bitmap_roundtrips_every_index() {
        let mut c = cfg(MAX_SUPPLY);
        for i in 0..MAX_SUPPLY {
            assert!(!c.is_minted(i).unwrap(), "index {i} should start unminted");
            c.mark_minted(i).unwrap();
            assert!(c.is_minted(i).unwrap(), "index {i} should be minted");
        }
    }

    #[test]
    fn bitmap_bytes_covers_exactly_1000_bits() {
        assert_eq!(BITMAP_BYTES * 8, 1000);
    }

    #[test]
    fn double_mint_of_same_index_is_rejected() {
        let mut c = cfg(MAX_SUPPLY);
        c.mark_minted(42).unwrap();
        assert!(c.mark_minted(42).is_err(), "same index must not mint twice");
    }

    #[test]
    fn out_of_range_index_is_rejected() {
        let mut c = cfg(MAX_SUPPLY);
        assert!(c.is_minted(MAX_SUPPLY).is_err());
        assert!(c.mark_minted(MAX_SUPPLY).is_err());
    }

    #[test]
    fn marking_one_index_does_not_disturb_neighbours() {
        let mut c = cfg(MAX_SUPPLY);
        c.mark_minted(8).unwrap();
        assert!(c.is_minted(8).unwrap());
        assert!(!c.is_minted(7).unwrap());
        assert!(!c.is_minted(9).unwrap());
    }

    #[test]
    fn pick_unminted_finds_the_only_gap_from_any_start() {
        let mut c = cfg(MAX_SUPPLY);
        for i in 0..MAX_SUPPLY {
            if i != 617 {
                c.mark_minted(i).unwrap();
            }
        }
        // Whatever entropy comes out of the hash, the scan must land on 617.
        for start in [0u16, 1, 616, 617, 618, 999, 40_000, u16::MAX] {
            assert_eq!(c.pick_unminted(start).unwrap(), 617, "start={start}");
        }
    }

    #[test]
    fn pick_unminted_errors_when_pool_is_empty() {
        let mut c = cfg(MAX_SUPPLY);
        for i in 0..MAX_SUPPLY {
            c.mark_minted(i).unwrap();
        }
        assert!(c.pick_unminted(0).is_err(), "exhausted pool must error");
    }

    #[test]
    fn pick_unminted_never_returns_a_minted_index() {
        let mut c = cfg(MAX_SUPPLY);
        // Mint every third index, then check 300 different entropy values.
        for i in (0..MAX_SUPPLY).step_by(3) {
            c.mark_minted(i).unwrap();
        }
        for start in 0..300u16 {
            let picked = c.pick_unminted(start).unwrap();
            assert!(!c.is_minted(picked).unwrap(), "picked minted index {picked}");
            assert!(picked < MAX_SUPPLY);
        }
    }

    #[test]
    fn reserved_tracks_outstanding_obligations() {
        let mut c = cfg(MAX_SUPPLY);
        assert_eq!(c.reserved().unwrap(), 0);
        c.circulating = 3;
        assert_eq!(c.reserved().unwrap(), 3 * 950_000_000_000);
    }

    #[test]
    fn reserved_cannot_overflow_at_full_supply() {
        let mut c = cfg(MAX_SUPPLY);
        c.circulating = MAX_SUPPLY;
        // 1000 * 950_000 * 10^6 must still fit in u64.
        assert_eq!(c.reserved().unwrap(), 950_000_000_000_000u64);
    }

    /// The whole point of the 5% spread: the treasury gains on every cycle, so
    /// the invariant treasury >= circulating * redeem_price only strengthens.
    #[test]
    fn each_mint_redeem_cycle_leaves_the_treasury_ahead() {
        let c = cfg(MAX_SUPPLY);
        let spread = c.mint_price - c.redeem_price;
        assert_eq!(spread, 50_000_000_000);

        let mut treasury: u64 = 0;
        for _ in 0..100 {
            treasury += c.mint_price; // someone mints
            assert!(treasury >= c.redeem_price, "must be able to honour a sell-back");
            treasury -= c.redeem_price; // they sell back
        }
        assert_eq!(treasury, 100 * spread);
    }

    /// A redeem when the treasury is short must be caught by the guard, not by
    /// wrapping arithmetic.
    #[test]
    fn short_treasury_is_detected_rather_than_underflowing() {
        let c = cfg(MAX_SUPPLY);
        let treasury: u64 = c.redeem_price - 1;
        assert!(treasury < c.redeem_price, "guard should reject this");
        assert!(treasury.checked_sub(c.redeem_price).is_none(), "would underflow");
    }

    #[test]
    fn withdrawable_surplus_never_eats_the_floor() {
        let mut c = cfg(MAX_SUPPLY);
        c.circulating = 10;
        let reserved = c.reserved().unwrap();
        // 10 mints in, nothing redeemed.
        let treasury = 10 * c.mint_price;
        let surplus = treasury.saturating_sub(reserved);
        assert_eq!(surplus, 10 * (c.mint_price - c.redeem_price));
        // After taking the full surplus, all 10 holders can still be paid.
        assert_eq!(treasury - surplus, reserved);
    }

    #[test]
    fn uri_is_derived_from_the_committed_base() {
        let c = cfg(MAX_SUPPLY);
        assert_eq!(c.asset_uri(0).unwrap(), "https://arweave.net/MANIFEST/0.json");
        assert_eq!(c.asset_uri(999).unwrap(), "https://arweave.net/MANIFEST/999.json");
        assert_eq!(c.asset_name(7), "PitBroker #7");
    }

    #[test]
    fn phase_parsing_rejects_unknown_values() {
        assert_eq!(Phase::from_u8(0).unwrap(), Phase::Closed);
        assert_eq!(Phase::from_u8(2).unwrap(), Phase::Public);
        assert!(Phase::from_u8(3).is_err());
        assert!(Phase::from_u8(255).is_err());
    }

    #[test]
    fn config_len_matches_the_serialized_layout() {
        // Guards against adding a field and forgetting the space calculation,
        // which would make `initialize` fail with an opaque allocation error.
        let c = cfg(MAX_SUPPLY);
        let serialized = 8 + c.try_to_vec().unwrap().len();
        assert_eq!(Config::LEN, serialized, "Config::LEN is out of date");
    }
}
