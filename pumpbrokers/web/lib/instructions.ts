import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { MPL_CORE_PROGRAM_ID } from "@config";
import { configPda, programId, vaultPda } from "./pdas";

/**
 * Instructions built by hand rather than through the generated IDL client.
 *
 * The account ORDER below must match the `#[derive(Accounts)]` structs in
 * programs/pumpbrokers/src/lib.rs exactly — Anchor matches positionally, so a
 * reordering here produces a confusing constraint failure rather than a clear
 * one. Each list is annotated with its Rust counterpart.
 */

/** Anchor's discriminator: first 8 bytes of sha256("global:<snake_case_name>"). */
export async function discriminator(name: string): Promise<Uint8Array> {
  const text = `global:${name}`;
  // Copy into a plain ArrayBuffer: TextEncoder may hand back a view over a
  // SharedArrayBuffer, which SubtleCrypto does not accept.
  const buffer = new ArrayBuffer(text.length);
  const bytes = new Uint8Array(buffer);
  bytes.set(new TextEncoder().encode(text));
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return new Uint8Array(digest).slice(0, 8);
}

const core = () => new PublicKey(MPL_CORE_PROGRAM_ID);

/** Matches `MintNew` in lib.rs. */
export async function buildMintNewIx(params: {
  buyer: PublicKey;
  asset: PublicKey;
  collection: PublicKey;
  tokenMint: PublicKey;
  buyerTokenAccount: PublicKey;
  treasury: PublicKey;
}): Promise<TransactionInstruction> {
  return new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: params.buyer, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: true },
      { pubkey: vaultPda(), isSigner: false, isWritable: true },
      { pubkey: params.asset, isSigner: true, isWritable: true },
      { pubkey: params.collection, isSigner: false, isWritable: true },
      { pubkey: params.tokenMint, isSigner: false, isWritable: false },
      { pubkey: params.buyerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: params.treasury, isSigner: false, isWritable: true },
      { pubkey: core(), isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(await discriminator("mint_new")),
  });
}

/** Matches `MintRecycled` in lib.rs. */
export async function buildMintRecycledIx(params: {
  buyer: PublicKey;
  asset: PublicKey;
  collection: PublicKey;
  tokenMint: PublicKey;
  buyerTokenAccount: PublicKey;
  treasury: PublicKey;
}): Promise<TransactionInstruction> {
  return new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: params.buyer, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: true },
      { pubkey: vaultPda(), isSigner: false, isWritable: true },
      // Not a signer here — the asset already exists and the vault authorises it.
      { pubkey: params.asset, isSigner: false, isWritable: true },
      { pubkey: params.collection, isSigner: false, isWritable: true },
      { pubkey: params.tokenMint, isSigner: false, isWritable: false },
      { pubkey: params.buyerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: params.treasury, isSigner: false, isWritable: true },
      { pubkey: core(), isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(await discriminator("mint_recycled")),
  });
}

/** Matches `Redeem` in lib.rs. */
export async function buildRedeemIx(params: {
  holder: PublicKey;
  asset: PublicKey;
  collection: PublicKey;
  tokenMint: PublicKey;
  holderTokenAccount: PublicKey;
  treasury: PublicKey;
}): Promise<TransactionInstruction> {
  return new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: params.holder, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: true },
      { pubkey: vaultPda(), isSigner: false, isWritable: true },
      { pubkey: params.asset, isSigner: false, isWritable: true },
      { pubkey: params.collection, isSigner: false, isWritable: true },
      { pubkey: params.tokenMint, isSigner: false, isWritable: false },
      { pubkey: params.holderTokenAccount, isSigner: false, isWritable: true },
      { pubkey: params.treasury, isSigner: false, isWritable: true },
      { pubkey: core(), isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(await discriminator("redeem")),
  });
}

/** Matches `AdminOnly` in lib.rs. */
export async function buildSetPausedIx(params: {
  authority: PublicKey;
  pausedMint: boolean;
  pausedRedeem: boolean;
}): Promise<TransactionInstruction> {
  const disc = await discriminator("set_paused");
  const data = Buffer.alloc(disc.length + 2);
  Buffer.from(disc).copy(data, 0);
  data.writeUInt8(params.pausedMint ? 1 : 0, disc.length);
  data.writeUInt8(params.pausedRedeem ? 1 : 0, disc.length + 1);

  return new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: false },
      { pubkey: configPda(), isSigner: false, isWritable: true },
    ],
    data,
  });
}

/** Matches `AdminOnly` in lib.rs. */
export async function buildSetPhaseIx(params: {
  authority: PublicKey;
  phase: 0 | 1 | 2;
}): Promise<TransactionInstruction> {
  const disc = await discriminator("set_phase");
  const data = Buffer.alloc(disc.length + 1);
  Buffer.from(disc).copy(data, 0);
  data.writeUInt8(params.phase, disc.length);

  return new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: false },
      { pubkey: configPda(), isSigner: false, isWritable: true },
    ],
    data,
  });
}
