import { describe, expect, it } from "vitest";
import { decideGate } from "../src/engine/risk";
import { TOPIC } from "../src/engine/decode";
import { MAX_UINT256, type Address, type Hex, type RawLog, type SimulationOutcome } from "../src/engine/types";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address;

const topicFor = (a: string): Hex => `0x000000000000000000000000${a.slice(2).toLowerCase()}`;
const word = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}`;

const approvalLog = (amount: bigint): RawLog => ({
  address: USDC,
  topics: [TOPIC.approval, topicFor(ALICE), topicFor(ROUTER)],
  data: word(amount),
});

const transferLog = (from: string, to: string, v: bigint): RawLog => ({
  address: USDC,
  topics: [TOPIC.transfer, topicFor(from), topicFor(to)],
  data: word(v),
});

function outcome(partial: Partial<SimulationOutcome> = {}): SimulationOutcome {
  return {
    status: "success",
    logs: [],
    gasUsed: 21_000n,
    gasPrice: 1_000_000_000n,
    value: 0n,
    from: ALICE,
    chainId: 8453,
    adapter: "test",
    ...partial,
  };
}

const codes = (o: SimulationOutcome, extra = {}) =>
  decideGate({ outcome: o, watched: [ALICE], ...extra }).findings.map((f) => f.code);

describe("the gate always requires a signature", () => {
  /**
   * This is the product's central claim, so it is asserted across every shape of
   * input rather than on one happy path. There is no allowlist and no severity
   * low enough to skip the gate; if this test ever fails, the claim on the
   * landing page is false.
   */
  const cases: Array<[string, SimulationOutcome]> = [
    ["a plain success", outcome()],
    ["a revert", outcome({ status: "reverted", revertReason: "insufficient balance" })],
    ["an unavailable simulation", outcome({ status: "unavailable", unavailableReason: "no support" })],
    ["a harmless revocation", outcome({ logs: [approvalLog(0n)] })],
    ["a zero-value call", outcome({ gasUsed: 0n, gasPrice: 0n })],
    ["an inbound-only transfer", outcome({ logs: [transferLog(ROUTER, ALICE, 5n)] })],
  ];

  for (const [name, o] of cases) {
    it(`for ${name}`, () => {
      expect(decideGate({ outcome: o, watched: [ALICE] }).requiresSignature).toBe(true);
    });
  }
});

describe("simulation trust", () => {
  it("marks an unavailable simulation untrustworthy and shows no diff", () => {
    const decision = decideGate({
      outcome: outcome({ status: "unavailable", unavailableReason: "This RPC has no eth_simulateV1." }),
      watched: [ALICE],
    });

    expect(decision.trustworthy).toBe(false);
    expect(decision.severity).toBe("danger");
    expect(decision.deltas).toEqual([]);
    expect(decision.findings[0]!.code).toBe("simulation_unavailable");
    // The reason reaches the user verbatim rather than being swallowed.
    expect(decision.findings[0]!.detail).toContain("eth_simulateV1");
  });

  it("marks a revert untrustworthy and says it would fail", () => {
    const decision = decideGate({
      outcome: outcome({ status: "reverted", revertReason: "ERC20: transfer amount exceeds balance" }),
      watched: [ALICE],
    });
    expect(decision.trustworthy).toBe(false);
    expect(decision.findings.map((f) => f.code)).toContain("simulation_reverted");
    expect(decision.findings[0]!.detail).toContain("exceeds balance");
  });

  it("trusts a successful simulation", () => {
    expect(decideGate({ outcome: outcome(), watched: [ALICE] }).trustworthy).toBe(true);
  });
});

describe("approval shape", () => {
  it("raises danger on an unlimited approval", () => {
    const decision = decideGate({ outcome: outcome({ logs: [approvalLog(MAX_UINT256)] }), watched: [ALICE] });
    expect(decision.severity).toBe("danger");
    const finding = decision.findings.find((f) => f.code === "unlimited_approval")!;
    expect(finding.severity).toBe("danger");
  });

  it("raises danger on setApprovalForAll", () => {
    const decision = decideGate({
      outcome: outcome({
        logs: [{ address: USDC, topics: [TOPIC.approvalForAll, topicFor(ALICE), topicFor(ROUTER)], data: word(1n) }],
      }),
      watched: [ALICE],
    });
    expect(decision.findings.map((f) => f.code)).toContain("approval_for_all");
    expect(decision.severity).toBe("danger");
  });

  it("treats a revocation as information, not a warning", () => {
    const decision = decideGate({ outcome: outcome({ logs: [approvalLog(0n)] }), watched: [ALICE] });
    const finding = decision.findings.find((f) => f.code === "approval_revoked")!;
    expect(finding.severity).toBe("info");
    expect(decision.severity).toBe("info");
  });

  /**
   * The quiet version of the unlimited problem: an exact approval that outlives
   * the run it was granted for.
   */
  it("flags an approval larger than the run actually spends", () => {
    const decision = decideGate({
      outcome: outcome({
        logs: [approvalLog(10_000_000000n), transferLog(ALICE, ROUTER, 1_284_120000n)],
      }),
      watched: [ALICE],
    });
    const finding = decision.findings.find((f) => f.code === "approval_exceeds_need")!;
    expect(finding.severity).toBe("caution");
    expect(finding.detail).toContain("1284120000");
  });

  it("does not flag an approval that exactly matches the spend", () => {
    expect(
      codes(outcome({ logs: [approvalLog(1_284_120000n), transferLog(ALICE, ROUTER, 1_284_120000n)] })),
    ).not.toContain("approval_exceeds_need");
  });

  it("ignores approvals granted by someone else", () => {
    const foreign: RawLog = {
      address: USDC,
      topics: [TOPIC.approval, topicFor(ROUTER), topicFor(ROUTER)],
      data: word(MAX_UINT256),
    };
    const decision = decideGate({ outcome: outcome({ logs: [foreign] }), watched: [ALICE] });
    expect(decision.approvals).toHaveLength(0);
    expect(decision.findings.map((f) => f.code)).not.toContain("unlimited_approval");
  });

  it("flags a spender the user has not approved before", () => {
    expect(
      codes(outcome({ logs: [approvalLog(500n)] }), { knownSpenders: [] }),
    ).toContain("new_spender");
  });

  it("does not flag a spender the user has approved before", () => {
    expect(
      codes(outcome({ logs: [approvalLog(500n)] }), { knownSpenders: [ROUTER] }),
    ).not.toContain("new_spender");
  });

  it("never treats a known spender as a reason to lower severity", () => {
    const decision = decideGate({
      outcome: outcome({ logs: [approvalLog(MAX_UINT256)] }),
      watched: [ALICE],
      knownSpenders: [ROUTER],
    });
    expect(decision.severity).toBe("danger");
  });
});

describe("value movement", () => {
  it("cautions when assets leave the wallet", () => {
    expect(codes(outcome({ logs: [transferLog(ALICE, ROUTER, 5n)] }))).toContain("net_outflow");
  });

  it("does not caution on an inbound-only transfer", () => {
    expect(codes(outcome({ logs: [transferLog(ROUTER, ALICE, 5n)] }))).not.toContain("net_outflow");
  });

  it("says plainly when nothing moves", () => {
    expect(codes(outcome({ gasUsed: 0n, gasPrice: 0n }))).toContain("no_balance_change");
  });

  it("does not claim nothing moved when gas was spent and an approval was set", () => {
    expect(codes(outcome({ logs: [approvalLog(0n)] }))).not.toContain("no_balance_change");
  });
});
