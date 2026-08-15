import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { PUMPFUN } from "@config";
import { pumpBondingCreatorVault } from "./pdas";

/**
 * pump.fun creator-fee claim.
 *
 * Account order and discriminators come from the live IDLs in
 * pump-fun/pump-public-docs (`idl/pump.json`), read directly rather than copied
 * from a third-party guide.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWO THINGS THAT SHAPE THIS FILE
 *
 * 1. `creator` is NOT a signer on `collect_creator_fee`. It is a permissionless
 *    crank whose only possible destination is the creator's own wallet. The
 *    claim therefore cannot be redirected to the treasury inside the
 *    instruction — we follow it with a transfer in the same transaction.
 *
 * 2. Bonding-curve creator fees are paid in SOL (lamports), but the PitBrokers
 *    treasury is a $PUMPBROKER *token account*, which cannot hold SOL. So the
 *    second instruction sends lamports to the VAULT PDA — the same
 *    program-owned authority that owns the treasury — not to the token account.
 *    Converting that SOL into $PUMPBROKER to actually deepen redemption backing
 *    is a swap, and is deliberately out of scope here. See the note rendered on
 *    the admin page.
 * ────────────────────────────────────────────────────────────────────────────
 */

const PUMP_PROGRAM = () => new PublicKey(PUMPFUN.PUMP_PROGRAM_ID);

/** `["__event_authority"]` under the pump program. */
export function pumpEventAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PUMPFUN.EVENT_AUTHORITY_SEED)],
    PUMP_PROGRAM(),
  )[0];
}

/**
 * `pump::collect_creator_fee` — sweeps the bonding-curve vault to `creator`,
 * leaving the rent-exempt minimum behind.
 */
export function buildCollectCreatorFeeIx(creator: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_PROGRAM(),
    keys: [
      // Not a signer — see note 1 above. Writable because it receives lamports.
      { pubkey: creator, isSigner: false, isWritable: true },
      { pubkey: pumpBondingCreatorVault(creator), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: pumpEventAuthority(), isSigner: false, isWritable: false },
      // Anchor's self-CPI event pattern requires the program's own id here.
      { pubkey: PUMP_PROGRAM(), isSigner: false, isWritable: false },
    ],
    data: Buffer.from(PUMPFUN.IX.collectCreatorFee),
  });
}

/**
 * The full claim: sweep fees to the admin's wallet, then forward `amount`
 * lamports to the vault PDA — atomically, in one transaction.
 *
 * `amount` is computed by the caller from the vault's claimable balance. It is
 * passed explicitly rather than "forward everything" because the admin's wallet
 * also holds their own SOL, and a sweep-everything transfer would take it.
 */
export function buildClaimToTreasuryIxs(params: {
  creator: PublicKey;
  vault: PublicKey;
  lamports: bigint;
}): TransactionInstruction[] {
  if (params.lamports <= 0n) {
    throw new Error("Nothing to claim — the creator vault holds no fees above rent.");
  }
  if (params.lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Claim amount is implausibly large; refusing to build it.");
  }

  return [
    buildCollectCreatorFeeIx(params.creator),
    SystemProgram.transfer({
      fromPubkey: params.creator,
      toPubkey: params.vault,
      lamports: Number(params.lamports),
    }),
  ];
}

/**
 * Claimable lamports = vault balance minus the rent-exempt minimum, which the
 * program leaves behind. Returns 0n rather than a negative number.
 */
export function claimableLamports(
  vaultLamports: bigint,
  rentExemptMinimum: bigint,
): bigint {
  return vaultLamports > rentExemptMinimum ? vaultLamports - rentExemptMinimum : 0n;
}
