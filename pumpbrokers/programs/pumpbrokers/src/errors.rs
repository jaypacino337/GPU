use anchor_lang::prelude::*;

/// Error messages are user-facing. The frontend surfaces `msg` verbatim rather
/// than "transaction failed", so each one has to read as an explanation.
#[error_code]
pub enum PumpBrokersError {
    #[msg("Minting is paused.")]
    MintPaused,

    #[msg("Sell-back is paused.")]
    RedeemPaused,

    #[msg("All 1000 PumpBrokers have been minted.")]
    SoldOut,

    #[msg("Minting is not open yet.")]
    PhaseClosed,

    #[msg("The treasury cannot currently cover a sell-back. Check 'redemptions available' before trying again.")]
    InsufficientTreasury,

    #[msg("That PumpBroker does not belong to this collection.")]
    WrongCollection,

    #[msg("That asset is not held by the vault, so it cannot be minted.")]
    AssetNotInVault,

    #[msg("You do not own that PumpBroker.")]
    NotAssetOwner,

    #[msg("Withdrawal would dip into funds reserved to back outstanding sell-backs.")]
    WouldBreakFloor,

    #[msg("That asset index is already minted.")]
    IndexAlreadyMinted,

    #[msg("Asset index is out of range.")]
    IndexOutOfRange,

    #[msg("Arithmetic overflow.")]
    MathOverflow,

    #[msg("Prices are invalid: sell-back price must be below mint price and both must be non-zero.")]
    InvalidPrices,

    #[msg("Supply cap must be between 1 and 1000.")]
    InvalidSupplyCap,

    #[msg("Treasury account does not match the one recorded in config.")]
    TreasuryMismatch,

    #[msg("Could not read the Core asset account.")]
    InvalidAssetAccount,

    #[msg("No unminted PumpBrokers remain in the pool.")]
    PoolExhausted,

    #[msg("Unexpected phase value.")]
    InvalidPhase,

    #[msg("Metadata base URI is empty, too long, or not valid UTF-8.")]
    InvalidBaseUri,
}
