import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress, getMint } from "@solana/spl-token";
import { airdropReadiness, payoutMint, CLUSTER, type TickerConfig } from "@config";
import type { BrokerAsset } from "@/components/NftCard";

/**
 * Airdrop safety gates.
 *
 * Two rules from the spec, enforced here rather than trusted to the operator:
 *   1. Refuse to run for any ticker whose mint address is not set.
 *   2. Verify on-chain that the mint EXISTS and the treasury holds enough
 *      balance before the send button is enabled.
 *
 * Config-level readiness alone is not enough — a typo'd but well-formed address
 * passes rule 1 and fails rule 2.
 */

export interface SnapshotRow {
  owner: string;
  /** Pieces this owner holds carrying the ticker. */
  count: number;
  assets: string[];
  /** Base units to send, count x amountPerNft. */
  amount: bigint;
}

export interface Preflight {
  ticker: TickerConfig;
  ok: boolean;
  blockers: string[];
  warnings: string[];
  rows: SnapshotRow[];
  totalRecipients: number;
  totalAmount: bigint;
  treasuryBalance: bigint | null;
  payoutMintAddress: string | null;
}

/** Group a live snapshot into per-owner rows for one ticker. */
export function rowsForTicker(
  holders: Map<string, BrokerAsset[]>,
  ticker: TickerConfig,
  decimals: number,
): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  for (const [owner, assets] of holders) {
    const matching = assets.filter((a) => a.airdropTicker === ticker.symbol);
    if (matching.length === 0) continue;
    rows.push({
      owner,
      count: matching.length,
      assets: matching.map((a) => a.address),
      amount:
        BigInt(matching.length) * ticker.amountPerNft * 10n ** BigInt(decimals),
    });
  }
  return rows.sort((a, b) => b.count - a.count || a.owner.localeCompare(b.owner));
}

/**
 * `funder` is the wallet whose token account actually pays out — the admin's
 * own, since it is the admin that signs each transfer. It is NOT the
 * $PUMPBROKER treasury token account: that account holds a different mint and
 * its authority is a PDA that cannot sign an arbitrary SPL transfer.
 */
export async function preflight(
  connection: Connection,
  ticker: TickerConfig,
  holders: Map<string, BrokerAsset[]>,
  funder: PublicKey,
): Promise<Preflight> {
  const blockers: string[] = [];
  const warnings: string[] = [];

  // Rule 1 — config gate.
  const readiness = airdropReadiness().find((r) => r.ticker.symbol === ticker.symbol);
  if (readiness && !readiness.configured) blockers.push(...readiness.blockers);

  const decimals = typeof ticker.decimals === "number" ? ticker.decimals : 0;
  const rows = rowsForTicker(holders, ticker, decimals);
  const totalAmount = rows.reduce((sum, r) => sum + r.amount, 0n);

  if (rows.length === 0) {
    blockers.push(`No holders found carrying ${ticker.symbol}.`);
  }

  const expected = ticker.expectedCount;
  const found = rows.reduce((sum, r) => sum + r.count, 0);
  if (found !== expected) {
    // Not fatal — pieces sitting in the vault legitimately reduce the count.
    warnings.push(
      `Found ${found} ${ticker.symbol} pieces held by wallets, expected ${expected}. ` +
        "Any difference is normally pieces currently held by the vault.",
    );
  }

  let treasuryBalance: bigint | null = null;
  let payoutMintAddress: string | null = null;

  if (blockers.length === 0) {
    try {
      const address = payoutMint(ticker, CLUSTER as "devnet" | "mainnet-beta");
      payoutMintAddress = address;
      const mintPk = new PublicKey(address);

      // Rule 2a — the mint must actually exist on this cluster.
      const mintInfo = await getMint(connection, mintPk);
      if (mintInfo.decimals !== decimals) {
        blockers.push(
          `${ticker.symbol} on-chain decimals are ${mintInfo.decimals}, but config says ${decimals}. ` +
            "Sending with the wrong decimals would be off by a power of ten.",
        );
      }

      // Rule 2b — the funding wallet must hold enough to cover the whole run.
      const ata = await getAssociatedTokenAddress(mintPk, funder, true);
      const account = await getAccount(connection, ata);
      treasuryBalance = account.amount;

      if (treasuryBalance < totalAmount) {
        blockers.push(
          `Funding wallet holds ${treasuryBalance} base units of ${ticker.symbol} ` +
            `but the distribution needs ${totalAmount}. Top it up before sending.`,
        );
      }
    } catch (e) {
      blockers.push(
        `Could not verify ${ticker.symbol} on chain: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  return {
    ticker,
    ok: blockers.length === 0,
    blockers,
    warnings,
    rows,
    totalRecipients: rows.length,
    totalAmount,
    treasuryBalance,
    payoutMintAddress,
  };
}

/** CSV for review before anything is sent. */
export function toCsv(preflightResult: Preflight, decimals: number): string {
  const header = "owner,pieces,amount_base_units,amount_whole,assets";
  const lines = preflightResult.rows.map((row) => {
    const scale = 10n ** BigInt(decimals);
    const whole = row.amount / scale;
    const frac = (row.amount % scale).toString().padStart(decimals, "0");
    const amountWhole = decimals > 0 ? `${whole}.${frac}` : `${whole}`;
    return [
      row.owner,
      row.count,
      row.amount.toString(),
      amountWhole,
      `"${row.assets.join(" ")}"`,
    ].join(",");
  });
  return [header, ...lines].join("\n");
}

/**
 * Stable key for idempotency: one transfer per (ticker, snapshot, owner).
 * Re-running after a partial failure skips anything already recorded, so a retry
 * cannot double-pay.
 */
export function transferKey(
  ticker: string,
  snapshotAt: string,
  owner: string,
): string {
  return `${ticker}:${snapshotAt}:${owner}`;
}
