import { PublicKey } from "@solana/web3.js";
import { PDA_SEEDS, PROGRAM_ID, PUMPFUN } from "@config";

export function programId(): PublicKey {
  return new PublicKey(PROGRAM_ID);
}

export function configPda(program = programId()): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.config)],
    program,
  )[0];
}

/** Owns the treasury token account and every recycled Core asset. */
export function vaultPda(program = programId()): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.vault)],
    program,
  )[0];
}

// ---------------------------------------------------------------------------
// pump.fun creator vaults
//
// The two programs use DIFFERENT seeds for what is conceptually the same thing.
// These wrappers exist so no call site has to remember which is which — getting
// it wrong derives a valid-looking but nonexistent PDA, which reads as a zero
// balance rather than an error.
// ---------------------------------------------------------------------------

/** Bonding-curve vault. Seed is "creator-vault" — hyphen. Holds SOL. */
export function pumpBondingCreatorVault(creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PUMPFUN.CREATOR_VAULT_SEED_BONDING), creator.toBuffer()],
    new PublicKey(PUMPFUN.PUMP_PROGRAM_ID),
  )[0];
}

/** AMM vault authority. Seed is "creator_vault" — underscore. Holds SPL. */
export function pumpAmmCreatorVaultAuthority(creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PUMPFUN.CREATOR_VAULT_SEED_AMM), creator.toBuffer()],
    new PublicKey(PUMPFUN.PUMP_AMM_PROGRAM_ID),
  )[0];
}
