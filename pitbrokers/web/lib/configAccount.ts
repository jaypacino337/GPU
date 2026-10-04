import { PublicKey } from "@solana/web3.js";

/**
 * Manual decoder for the program's `Config` account.
 *
 * Deliberately hand-written rather than driven by the generated IDL: the site
 * needs to read chain state before/without an IDL bundle, and the layout is
 * small and stable. It MUST stay in sync with
 * `programs/pitbrokers/src/state.rs` — the byte offsets below mirror that
 * struct in declaration order, and `EXPECTED_LEN` is asserted on every decode so
 * a layout change fails loudly here instead of silently misreading prices.
 */

export const BITMAP_BYTES = 125;
export const BASE_URI_BYTES = 128;

/** 8 discriminator + 4 pubkeys + 2 u64 + 3 u16 + 5 single bytes + uri + bitmap. */
export const EXPECTED_LEN =
  8 + 32 * 4 + 8 * 2 + 2 * 3 + 5 + BASE_URI_BYTES + 1 + BITMAP_BYTES;

export interface ConfigAccount {
  authority: PublicKey;
  tokenMint: PublicKey;
  collection: PublicKey;
  treasury: PublicKey;
  mintPrice: bigint;
  redeemPrice: bigint;
  supplyCap: number;
  mintedCount: number;
  circulating: number;
  pausedMint: boolean;
  pausedRedeem: boolean;
  phase: number;
  baseUri: string;
  bitmap: Uint8Array;
}

class Cursor {
  private offset = 0;
  constructor(private readonly view: DataView, private readonly bytes: Uint8Array) {}

  pubkey(): PublicKey {
    const slice = this.bytes.subarray(this.offset, this.offset + 32);
    this.offset += 32;
    return new PublicKey(slice);
  }
  u64(): bigint {
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }
  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  u8(): number {
    return this.view.getUint8(this.offset++);
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  bytes_(n: number): Uint8Array {
    const slice = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }
  skip(n: number) {
    this.offset += n;
  }
}

export function decodeConfig(data: Uint8Array): ConfigAccount {
  if (data.length !== EXPECTED_LEN) {
    throw new Error(
      `Config account is ${data.length} bytes, expected ${EXPECTED_LEN}. ` +
        "The on-chain layout and web/lib/configAccount.ts have diverged — do not " +
        "trust any value decoded from this account until they match.",
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const c = new Cursor(view, data);

  c.skip(8); // anchor discriminator

  const authority = c.pubkey();
  const tokenMint = c.pubkey();
  const collection = c.pubkey();
  const treasury = c.pubkey();
  const mintPrice = c.u64();
  const redeemPrice = c.u64();
  const supplyCap = c.u16();
  const mintedCount = c.u16();
  const circulating = c.u16();
  const pausedMint = c.bool();
  const pausedRedeem = c.bool();
  const phase = c.u8();
  c.u8(); // vault_bump
  c.u8(); // bump
  const baseUriBytes = c.bytes_(BASE_URI_BYTES);
  const baseUriLen = c.u8();
  const bitmap = c.bytes_(BITMAP_BYTES);

  return {
    authority,
    tokenMint,
    collection,
    treasury,
    mintPrice,
    redeemPrice,
    supplyCap,
    mintedCount,
    circulating,
    pausedMint,
    pausedRedeem,
    phase,
    baseUri: new TextDecoder().decode(baseUriBytes.subarray(0, baseUriLen)),
    bitmap,
  };
}

/** True when index `i` has been created at some point. */
export function isMinted(bitmap: Uint8Array, index: number): boolean {
  const byte = bitmap[index >> 3];
  if (byte === undefined) return false;
  return (byte & (1 << index % 8)) !== 0;
}

export const PHASE_LABEL: Record<number, string> = {
  0: "Closed",
  1: "Allowlist",
  2: "Public",
};
