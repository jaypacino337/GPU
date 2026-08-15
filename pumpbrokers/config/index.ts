/**
 * PumpBrokers — single source of truth.
 *
 * Every price, address and supply number in this project lives here. Nothing in
 * `app/` may hardcode an amount or a pubkey; import from this file instead.
 *
 * Placeholders are the literal string `SET_ME`. `assertConfigReady()` throws on
 * them rather than letting a zero or a default silently reach a transaction.
 */

import { UNSET } from "./unset";

export { UNSET };

export type Cluster = "devnet" | "mainnet-beta";

/** Flip to "mainnet-beta" only when the mainnet checklist is done and signed off. */
export const CLUSTER: Cluster = (process.env.NEXT_PUBLIC_CLUSTER as Cluster) ?? "devnet";

// ---------------------------------------------------------------------------
// $PUMPBROKER
// ---------------------------------------------------------------------------

/**
 * BLOCKED: needs the real mint address.
 *
 * DECIMALS IS NOT COSMETIC. Prices below are expressed in whole tokens and
 * converted to base units with `10n ** DECIMALS`. If DECIMALS is wrong every
 * amount is off by a power of ten, so it is validated, never defaulted.
 */
export const TOKEN = {
  mint: (process.env.NEXT_PUBLIC_TOKEN_MINT ?? UNSET) as string,
  decimals: process.env.NEXT_PUBLIC_TOKEN_DECIMALS
    ? Number(process.env.NEXT_PUBLIC_TOKEN_DECIMALS)
    : (UNSET as unknown as number),
  symbol: "PUMPBROKER",
} as const;

// ---------------------------------------------------------------------------
// Economics — integers only, no floats ever
// ---------------------------------------------------------------------------

/** Whole tokens paid to mint one PumpBroker. */
export const MINT_PRICE_TOKENS = 1_000_000n;

/** Whole tokens returned when selling one back. 95% of mint — the floor. */
export const REDEEM_PRICE_TOKENS = 950_000n;

export const SUPPLY_CAP = 1000;

/** Basis points kept by the treasury per mint→redeem cycle. Derived, not typed twice. */
export const SPREAD_BPS = Number(
  ((MINT_PRICE_TOKENS - REDEEM_PRICE_TOKENS) * 10_000n) / MINT_PRICE_TOKENS,
);

function requireDecimals(): bigint {
  const d = TOKEN.decimals;
  if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 18) {
    throw new Error(
      "[config] NEXT_PUBLIC_TOKEN_DECIMALS is unset or invalid. Set it to the real " +
        "$PUMPBROKER decimals — a wrong value scales every amount by a power of ten.",
    );
  }
  return BigInt(d);
}

/** Base units for one whole token. */
export function oneToken(): bigint {
  return 10n ** requireDecimals();
}

export function mintPriceBaseUnits(): bigint {
  return MINT_PRICE_TOKENS * oneToken();
}

export function redeemPriceBaseUnits(): bigint {
  return REDEEM_PRICE_TOKENS * oneToken();
}

/**
 * How many sell-backs the treasury can currently honour.
 * Integer division — deliberately floors, so we never advertise a redemption we
 * cannot pay. Surfaced on the site as "redemptions currently available: N".
 */
export function redemptionsAvailable(treasuryBaseUnits: bigint): number {
  const price = redeemPriceBaseUnits();
  if (price <= 0n) throw new Error("[config] redeem price must be positive");
  if (treasuryBaseUnits <= 0n) return 0;
  return Number(treasuryBaseUnits / price);
}

/**
 * Treasury funds that back outstanding redemptions and must never be withdrawn.
 * Mirrors the on-chain cap in `withdraw_surplus`.
 */
export function reservedForRedemptions(circulating: number): bigint {
  return BigInt(circulating) * redeemPriceBaseUnits();
}

// ---------------------------------------------------------------------------
// Program + on-chain addresses
// ---------------------------------------------------------------------------

export const PROGRAM_ID = (process.env.NEXT_PUBLIC_PROGRAM_ID ?? UNSET) as string;

/** BLOCKED: the wallet that owns pause / airdrop / fee-collect. */
export const ADMIN_WALLET = (process.env.NEXT_PUBLIC_ADMIN_WALLET ?? UNSET) as string;

/** Core collection address, produced by `scripts/create-collection.ts`. */
export const COLLECTION = (process.env.NEXT_PUBLIC_COLLECTION ?? UNSET) as string;

export const PDA_SEEDS = {
  config: "config",
  vault: "vault",
} as const;

/** Metaplex Core program — stable across clusters. */
export const MPL_CORE_PROGRAM_ID = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";

// ---------------------------------------------------------------------------
// RPC — server-side only
// ---------------------------------------------------------------------------

/**
 * The Helius key must never reach the browser. Client code calls our own
 * `/api/rpc` proxy; only server code reads this.
 */
export function serverRpcUrl(): string {
  const url = process.env.HELIUS_RPC_URL;
  if (!url) throw new Error("[config] HELIUS_RPC_URL is not set (server-side only)");
  if (typeof window !== "undefined") {
    throw new Error("[config] serverRpcUrl() must never be called from the browser");
  }
  return url;
}

/** What the browser talks to. Our proxy, never a keyed upstream. */
export const CLIENT_RPC_PATH = "/api/rpc";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ConfigProblem = { key: string; detail: string };

/** Non-throwing audit, so the admin page can render a readiness checklist. */
export function configProblems(): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const need: Array<[string, string]> = [
    ["TOKEN.mint", TOKEN.mint],
    ["PROGRAM_ID", PROGRAM_ID],
    ["ADMIN_WALLET", ADMIN_WALLET],
    ["COLLECTION", COLLECTION],
  ];
  for (const [key, value] of need) {
    if (!value || value === UNSET) problems.push({ key, detail: "not set" });
  }
  try {
    requireDecimals();
  } catch {
    problems.push({ key: "TOKEN.decimals", detail: "not set or out of range" });
  }
  if (REDEEM_PRICE_TOKENS >= MINT_PRICE_TOKENS) {
    problems.push({
      key: "REDEEM_PRICE_TOKENS",
      detail: "must be strictly below mint price or the treasury drains",
    });
  }
  return problems;
}

/** Call before anything that builds a transaction. */
export function assertConfigReady(): void {
  const problems = configProblems();
  if (problems.length) {
    throw new Error(
      "[config] not ready:\n" +
        problems.map((p) => `  - ${p.key}: ${p.detail}`).join("\n"),
    );
  }
}

export { PUMPFUN } from "./pumpfun";
export {
  TICKERS,
  PayoutAsset,
  airdropReadiness,
  getTicker,
  isTickerConfigured,
  payoutMint,
  USDC_MINT,
} from "./tickers";
export type { TickerConfig } from "./tickers";
