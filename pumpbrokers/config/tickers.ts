/**
 * The 10 tokenized-stock tickers carried by 100 of the 1,000 PumpBrokers
 * (10 pieces each) via the `Airdrop` metadata attribute.
 *
 * Only GMEx has a verified mint. The other nine are deliberately left as the
 * `SET_ME` placeholder: the airdrop tool must REFUSE to run for any ticker whose
 * mint is unset, so an unset value has to be detectable rather than plausible.
 */

import { UNSET } from "./index";

/** Per-ticker payout switch — the xStock itself, or its USDC equivalent. */
export enum PayoutAsset {
  XStock = "xstock",
  Usdc = "usdc",
}

export const USDC_MINT = {
  "mainnet-beta": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  /** Circle's canonical devnet USDC. */
  devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
} as const;

export interface TickerConfig {
  /** Attribute value as it appears in the NFT metadata, e.g. "GMEx". */
  symbol: string;
  name: string;
  /** xStock SPL mint, or UNSET if not yet verified. */
  mint: string;
  /** Which asset holders actually receive. */
  payout: PayoutAsset;
  /** Whole units of the payout asset per eligible NFT. */
  amountPerNft: bigint;
  decimals: number | typeof UNSET;
  /** Expected count of NFTs carrying this ticker. Used as a snapshot sanity check. */
  expectedCount: number;
}

export const TICKERS: TickerConfig[] = [
  {
    symbol: "GMEx",
    name: "GameStop",
    // The one verified mint.
    mint: "Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc",
    payout: PayoutAsset.XStock,
    amountPerNft: 1n,
    decimals: 8,
    expectedCount: 10,
  },
  ...(
    [
      ["TSLAx", "Tesla"],
      ["NVDAx", "NVIDIA"],
      ["MSTRx", "MicroStrategy"],
      ["HOODx", "Robinhood"],
      ["COINx", "Coinbase"],
      ["CRCLx", "Circle"],
      ["AAPLx", "Apple"],
      ["METAx", "Meta"],
      ["SPYx", "S&P 500 ETF"],
    ] as const
  ).map(
    ([symbol, name]): TickerConfig => ({
      symbol,
      name,
      mint: UNSET,
      payout: PayoutAsset.XStock,
      amountPerNft: 1n,
      decimals: UNSET,
      expectedCount: 10,
    }),
  ),
];

export function getTicker(symbol: string): TickerConfig | undefined {
  return TICKERS.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase());
}

/** True when this ticker's mint has been verified and set. */
export function isTickerConfigured(t: TickerConfig): boolean {
  return t.mint !== UNSET && !!t.mint && typeof t.decimals === "number";
}

export interface TickerReadiness {
  ticker: TickerConfig;
  configured: boolean;
  /** Blocking reasons. Non-empty means the send button stays disabled. */
  blockers: string[];
}

/**
 * Static readiness. This is only the config-level gate — the airdrop tool ALSO
 * verifies on-chain that the mint exists and the treasury holds enough balance
 * before enabling send. See `app/lib/airdrop/preflight.ts`.
 */
export function airdropReadiness(): TickerReadiness[] {
  return TICKERS.map((ticker) => {
    const blockers: string[] = [];
    if (ticker.mint === UNSET || !ticker.mint) {
      blockers.push(`${ticker.symbol} mint address is not set`);
    }
    if (typeof ticker.decimals !== "number") {
      blockers.push(`${ticker.symbol} decimals are not set`);
    }
    if (ticker.amountPerNft <= 0n) {
      blockers.push(`${ticker.symbol} amount per NFT must be positive`);
    }
    return { ticker, configured: blockers.length === 0, blockers };
  });
}

/** The mint that will actually be transferred, honouring the payout switch. */
export function payoutMint(t: TickerConfig, cluster: keyof typeof USDC_MINT): string {
  return t.payout === PayoutAsset.Usdc ? USDC_MINT[cluster] : t.mint;
}
