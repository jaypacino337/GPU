/**
 * Risk classification and the gate decision.
 *
 * The one rule this module exists to enforce: **a companion never signs.**
 * `requiresSignature` is true for every outcome that is not a read, including
 * outcomes the engine could not simulate and outcomes it believes are harmless.
 * There is no allowlist, no "trusted contract" path, and no severity low enough
 * to skip the gate. `test/risk.test.ts` asserts that across every input shape.
 */

import { decodeApproval } from "./decode";
import { computeAssetDeltas, gasCost, totalSent } from "./diff";
import {
  sameAddress,
  type ApprovalChange,
  type Finding,
  type GateDecision,
  type Severity,
  type SimulationOutcome,
} from "./types";

const ORDER: Record<Severity, number> = { info: 0, caution: 1, danger: 2 };

function worst(findings: readonly Finding[]): Severity {
  return findings.reduce<Severity>(
    (acc, f) => (ORDER[f.severity] > ORDER[acc] ? f.severity : acc),
    "info",
  );
}

export interface RiskInput {
  outcome: SimulationOutcome;
  watched: readonly string[];
  /**
   * Spenders this user has approved before. Used only to mark a spender as new;
   * being known is never a reason to weaken the gate.
   */
  knownSpenders?: readonly string[];
  /** Token decimals, for readable findings. Missing decimals degrade the text, not the check. */
  decimals?: Record<string, number>;
}

export function collectApprovals(outcome: SimulationOutcome, watched: readonly string[]): ApprovalChange[] {
  const out: ApprovalChange[] = [];
  for (const log of outcome.logs) {
    const approval = decodeApproval(log);
    if (!approval) continue;
    // Only the user's own approvals matter here.
    if (!watched.some((w) => sameAddress(w, approval.owner))) continue;
    out.push({
      owner: approval.owner,
      spender: approval.spender,
      token: approval.token,
      standard: approval.standard,
      scope: approval.scope,
    });
  }
  return out;
}

export function decideGate(input: RiskInput): GateDecision {
  const { outcome, watched } = input;
  const findings: Finding[] = [];

  // ---- can the diff be trusted at all? ------------------------------------
  if (outcome.status === "unavailable") {
    findings.push({
      code: "simulation_unavailable",
      severity: "danger",
      title: "No simulation available",
      detail:
        outcome.unavailableReason ??
        "This chain or RPC cannot simulate the transaction, so there is no balance diff to show. You can still sign — you are just doing it with less information.",
    });
    return {
      requiresSignature: true,
      trustworthy: false,
      severity: "danger",
      findings,
      deltas: [],
      approvals: [],
    };
  }

  if (outcome.status === "reverted") {
    findings.push({
      code: "simulation_reverted",
      severity: "danger",
      title: "This transaction would fail",
      detail: outcome.revertReason
        ? `It reverts with: ${outcome.revertReason}. Signing it would spend gas and change nothing.`
        : "It reverts. Signing it would spend gas and change nothing.",
    });
  }

  const deltas = computeAssetDeltas({ outcome, watched });
  const approvals = collectApprovals(outcome, watched);

  // ---- approval shape -----------------------------------------------------
  for (const approval of approvals) {
    if (approval.scope.kind === "unlimited") {
      findings.push({
        code: "unlimited_approval",
        severity: "danger",
        title: "Unlimited approval",
        detail: `${short(approval.spender)} would be able to move any amount of this token from your wallet, at any time in the future, until you revoke it. Plum never sets unlimited approvals itself.`,
      });
    } else if (approval.scope.kind === "all") {
      findings.push({
        code: "approval_for_all",
        severity: "danger",
        title: "Approval for every token in the collection",
        detail: `${short(approval.spender)} would be able to transfer any NFT you hold in this collection, including ones you buy later.`,
      });
    } else if (approval.scope.kind === "revoked") {
      findings.push({
        code: "approval_revoked",
        severity: "info",
        title: "Approval revoked",
        detail: `This sets ${short(approval.spender)}'s allowance to zero. Revoking cannot move funds.`,
      });
    } else {
      // An exact approval that far exceeds what this run actually spends is the
      // quiet version of the unlimited problem: the leftover allowance survives
      // the run.
      const needed = totalSent(deltas, approval.token);
      if (needed > 0n && approval.scope.amount > needed) {
        findings.push({
          code: "approval_exceeds_need",
          severity: "caution",
          title: "Approval larger than this run needs",
          detail: `This run moves ${needed} base units, but approves ${approval.scope.amount}. The difference stays approved for ${short(approval.spender)} after the run finishes.`,
        });
      }
    }

    if (
      input.knownSpenders &&
      !input.knownSpenders.some((s) => sameAddress(s, approval.spender)) &&
      approval.scope.kind !== "revoked"
    ) {
      findings.push({
        code: "new_spender",
        severity: "caution",
        title: "First time approving this spender",
        detail: `You have not approved ${short(approval.spender)} before. Check it is the contract you meant.`,
      });
    }
  }

  // ---- value movement -----------------------------------------------------
  const outflows = deltas.filter((d) => d.delta < 0n && d.reason !== "gas");
  if (outflows.length > 0) {
    findings.push({
      code: "net_outflow",
      severity: "caution",
      title: outflows.length === 1 ? "One asset leaves your wallet" : `${outflows.length} assets leave your wallet`,
      detail: "Check the diff below against what you asked for.",
    });
  }

  if (deltas.length === 0 && approvals.length === 0 && outcome.status === "success") {
    findings.push({
      code: "no_balance_change",
      severity: "info",
      title: "No balance change",
      detail:
        "The simulation shows nothing moving in or out of your watched addresses. That is expected for a revocation or a configuration call.",
    });
  }

  const gas = gasCost(outcome);
  if (gas > 0n) {
    findings.push({
      code: "gas",
      severity: "info",
      title: "Network fee",
      detail: `${gas} wei at ${outcome.gasPrice} wei per gas.`,
    });
  }

  return {
    // Not configurable, not overridable: reaching this function at all means a
    // state change, and a state change always stops for a human.
    requiresSignature: true,
    trustworthy: outcome.status === "success",
    severity: worst(findings),
    findings,
    deltas,
    approvals,
  };
}

function short(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
