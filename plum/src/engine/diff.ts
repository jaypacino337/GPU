/**
 * The balance diff.
 *
 * Input is one adapter's `SimulationOutcome`; output is the signed movements the
 * gate shows. Pure, so every branch here is unit-testable without a chain.
 *
 * Two decisions worth knowing about:
 *
 * 1. Inflows and outflows of the same token are kept as SEPARATE rows rather
 *    than netted. A run that claims 1,284 USDC and immediately repays 1,284
 *    USDC nets to zero, and showing "0 USDC" would hide both halves of what the
 *    transaction actually does.
 *
 * 2. Gas is its own row, never folded into the native movement. When an adapter
 *    gives authoritative pre/post native balances those already include gas, so
 *    it is added back out to keep the two figures separate and honest.
 */

import { decodeTransfer } from "./decode";
import {
  isWatched,
  sameAddress,
  type AssetDelta,
  type Address,
  type SimulationOutcome,
} from "./types";

export interface DiffInput {
  outcome: SimulationOutcome;
  /** The user's addresses. Movements involving anything else are ignored. */
  watched: readonly string[];
}

export function gasCost(outcome: SimulationOutcome): bigint {
  return outcome.gasUsed * outcome.gasPrice;
}

/** Key that keeps inflow and outflow of one token on separate rows. */
function key(d: Omit<AssetDelta, "delta">): string {
  return [d.account.toLowerCase(), d.kind, d.token?.toLowerCase() ?? "-", d.tokenId?.toString() ?? "-", d.reason].join("|");
}

export function computeAssetDeltas({ outcome, watched }: DiffInput): AssetDelta[] {
  if (outcome.status === "unavailable") return [];

  const acc = new Map<string, AssetDelta>();

  const add = (d: AssetDelta) => {
    if (d.delta === 0n) return;
    const k = key(d);
    const existing = acc.get(k);
    if (existing) existing.delta += d.delta;
    else acc.set(k, { ...d });
  };

  // ---- token movements, from logs -----------------------------------------
  for (const log of outcome.logs) {
    const transfer = decodeTransfer(log);
    if (!transfer) continue;

    const amount =
      transfer.standard === "erc20" ? (transfer.value ?? 0n) : 1n;

    if (isWatched(transfer.from, watched)) {
      add({
        account: transfer.from,
        kind: transfer.standard,
        token: transfer.token,
        ...(transfer.tokenId !== undefined ? { tokenId: transfer.tokenId } : {}),
        delta: -amount,
        reason: "sent",
      });
    }
    if (isWatched(transfer.to, watched)) {
      add({
        account: transfer.to,
        kind: transfer.standard,
        token: transfer.token,
        ...(transfer.tokenId !== undefined ? { tokenId: transfer.tokenId } : {}),
        delta: amount,
        reason: "received",
      });
    }
  }

  // ---- native movement ----------------------------------------------------
  const gas = gasCost(outcome);

  if (outcome.nativeBalances) {
    for (const [address, { pre, post }] of Object.entries(outcome.nativeBalances)) {
      if (!isWatched(address, watched)) continue;

      // The authoritative reading already has gas deducted. Add it back so the
      // movement and the fee stay separate rows.
      const isPayer = sameAddress(address, outcome.from);
      const movement = post - pre + (isPayer ? gas : 0n);

      add({
        account: address as Address,
        kind: "native",
        delta: movement,
        reason: movement < 0n ? "sent" : "received",
      });
    }
  } else if (outcome.value > 0n) {
    // No authoritative reading: fall back to the top-level call's value. This
    // misses ETH moved by inner calls, which is why adapters that can read
    // balances are preferred.
    if (isWatched(outcome.from, watched)) {
      add({ account: outcome.from, kind: "native", delta: -outcome.value, reason: "sent" });
    }
    if (outcome.to && isWatched(outcome.to, watched)) {
      add({ account: outcome.to, kind: "native", delta: outcome.value, reason: "received" });
    }
  }

  if (gas > 0n && isWatched(outcome.from, watched)) {
    add({ account: outcome.from, kind: "native", delta: -gas, reason: "gas" });
  }

  return [...acc.values()];
}

/** Net movement per (account, token), for a one-line summary. */
export function netByAsset(deltas: readonly AssetDelta[]): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const d of deltas) {
    const k = `${d.account.toLowerCase()}|${d.kind}|${d.token?.toLowerCase() ?? "native"}`;
    net.set(k, (net.get(k) ?? 0n) + d.delta);
  }
  return net;
}

/** Total leaving the watched accounts for one token, ignoring gas. */
export function totalSent(
  deltas: readonly AssetDelta[],
  token: string | undefined,
): bigint {
  let sent = 0n;
  for (const d of deltas) {
    if (d.reason === "gas") continue;
    if (token === undefined ? d.kind !== "native" : !sameAddress(d.token, token)) continue;
    if (d.delta < 0n) sent += -d.delta;
  }
  return sent;
}
