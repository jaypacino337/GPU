/**
 * pump.fun creator-fee constants.
 *
 * Taken from the live IDLs in pump-fun/pump-public-docs (`idl/pump.json`,
 * `idl/pump_amm.json`), read directly rather than copied from a blog post.
 */

export const PUMPFUN = {
  /** Bonding-curve program. Fees accrue here as raw lamports pre-migration. */
  PUMP_PROGRAM_ID: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",

  /** AMM program. Fees accrue here as quote-mint SPL tokens post-migration. */
  PUMP_AMM_PROGRAM_ID: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",

  /**
   * ⚠️ THE SEEDS DIFFER BETWEEN THE TWO PROGRAMS AND THIS IS NOT A TYPO.
   *
   *   bonding curve : "creator-vault"  (HYPHEN)
   *   AMM           : "creator_vault"  (UNDERSCORE)
   *
   * Swapping them derives a valid-looking but non-existent PDA, which reads as a
   * zero balance instead of an error — i.e. it fails by silently telling you that
   * you have no fees to claim. Verified against both IDLs.
   */
  CREATOR_VAULT_SEED_BONDING: "creator-vault",
  CREATOR_VAULT_SEED_AMM: "creator_vault",

  EVENT_AUTHORITY_SEED: "__event_authority",

  /** Anchor discriminators, straight from the IDLs. */
  IX: {
    /** pump::collect_creator_fee — SOL payout. `creator` is NOT a signer. */
    collectCreatorFee: [20, 22, 86, 123, 198, 28, 219, 132],
    /** pump::collect_creator_fee_v2 — SPL quote-mint payout. */
    collectCreatorFeeV2: [207, 17, 138, 242, 4, 34, 19, 56],
    /** pump_amm::collect_coin_creator_fee */
    collectCoinCreatorFee: [160, 57, 89, 42, 181, 139, 43, 66],
  },

  /**
   * Neither claim instruction requires the creator to sign — both are
   * permissionless cranks whose only possible destination is the creator's own
   * wallet. Consequence: the claim cannot be redirected to the treasury inside
   * the instruction. We follow it with a transfer in the same transaction,
   * signed by the admin's connected wallet. See PLAN.md §1.1.
   */
  CLAIM_IS_PERMISSIONLESS: true,
} as const;
