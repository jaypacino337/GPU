/**
 * Core types for the Plum engine.
 *
 * The engine is deliberately network-free: everything here is plain data that a
 * chain adapter produces and the gate consumes. That split is what makes the
 * safety-critical logic (what changed, how risky is it) testable without an RPC.
 *
 * Every amount is a `bigint` of base units. No floats touch an amount anywhere
 * in this codebase — `number` is used only for counts, indices and severities.
 */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/** A log as an RPC returns it, before decoding. */
export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}

/** A signed change to one asset, for one account, in base units. */
export interface AssetDelta {
  account: Address;
  kind: "native" | "erc20" | "erc721";
  /** Absent for native. */
  token?: Address;
  /** Present only for erc721. */
  tokenId?: bigint;
  /** Signed. Negative leaves the account. */
  delta: bigint;
  /** Why it moved, in the user's language: "sold", "gas", "claimed". */
  reason: string;
}

/**
 * What an approval actually grants. `unlimited` and `all` are the two shapes
 * that lose people money, so they are distinct cases rather than a large number.
 */
export type ApprovalScope =
  | { kind: "exact"; amount: bigint }
  | { kind: "unlimited" }
  | { kind: "revoked" }
  | { kind: "all" };

export interface ApprovalChange {
  owner: Address;
  spender: Address;
  token: Address;
  standard: "erc20" | "erc721";
  scope: ApprovalScope;
}

/** What a chain adapter hands back. Adapters differ; this shape does not. */
export interface SimulationOutcome {
  status: "success" | "reverted" | "unavailable";
  /** Present when status is "reverted". */
  revertReason?: string;
  /** Present when status is "unavailable" — shown to the user verbatim. */
  unavailableReason?: string;
  logs: RawLog[];
  gasUsed: bigint;
  /** Wei per gas unit used for the cost line. */
  gasPrice: bigint;
  /** Native value carried by the top-level call. */
  value: bigint;
  from: Address;
  to?: Address;
  /**
   * Authoritative native balances where the adapter can read them. Preferred
   * over deriving native movement from value + gas, because it also catches
   * ETH moved by inner calls.
   */
  nativeBalances?: Record<string, { pre: bigint; post: bigint }>;
  chainId: number;
  /** Which adapter produced this, for the audit log. */
  adapter: string;
}

export type Severity = "info" | "caution" | "danger";

export interface Finding {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
}

/**
 * The gate. `requiresSignature` is never false for a state change — see
 * `decideGate` — and `trustworthy` is false whenever the diff should not be
 * read as authoritative.
 */
export interface GateDecision {
  requiresSignature: boolean;
  trustworthy: boolean;
  severity: Severity;
  findings: Finding[];
  deltas: AssetDelta[];
  approvals: ApprovalChange[];
}

/** Maximum uint256 — the canonical "unlimited" approval. */
export const MAX_UINT256 = (1n << 256n) - 1n;

/** Case-insensitive address comparison. Addresses arrive in mixed casing. */
export function sameAddress(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

export function isWatched(account: string, watched: readonly string[]): boolean {
  return watched.some((w) => sameAddress(w, account));
}
