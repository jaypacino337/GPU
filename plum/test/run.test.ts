import { describe, expect, it } from "vitest";
import {
  advance,
  CREDIT_COST,
  InvalidTransition,
  isSettled,
  startRun,
  validateSkill,
  type Run,
  type Skill,
} from "../src/engine/run";
import type { GateDecision, Hex } from "../src/engine/types";

const SKILL: Skill = {
  id: "weekly-compound",
  name: "Weekly compound",
  description: "Claim rewards and repay the loan.",
  steps: [
    { id: "read-positions", label: "Read positions across your wallets", kind: "read" },
    { id: "find-rewards", label: "Find claimable rewards", kind: "read" },
    { id: "quote", label: "Quote the best route", kind: "read" },
    { id: "execute", label: "Claim, swap and repay", kind: "write" },
  ],
};

const DECISION: GateDecision = {
  requiresSignature: true,
  trustworthy: true,
  severity: "caution",
  findings: [],
  deltas: [],
  approvals: [],
};

const SIG = "0xabc123" as Hex;

/** Drive a run to the gate, the way the companion loop does. */
function toGate(skill: Skill = SKILL): Run {
  let run = advance(startRun(skill, "run-1"), { type: "begin" });
  for (const step of skill.steps) {
    if (step.kind === "write") break;
    run = advance(run, { type: "step_done", stepId: step.id });
  }
  const write = skill.steps.find((s) => s.kind === "write")!;
  return advance(run, { type: "gate_opened", stepId: write.id, decision: DECISION });
}

describe("validateSkill", () => {
  it("accepts a well-formed skill", () => {
    expect(validateSkill(SKILL)).toEqual([]);
  });

  it("rejects an empty skill", () => {
    expect(validateSkill({ ...SKILL, steps: [] })[0]).toContain("at least one step");
  });

  it("rejects duplicate step ids", () => {
    const dup = { ...SKILL, steps: [...SKILL.steps, SKILL.steps[0]!] };
    expect(validateSkill(dup).join(" ")).toContain("Duplicate step id");
  });

  /**
   * Two writes in one skill would put a second gate behind the first, which is
   * how a user ends up approving something they did not read. One signature per
   * run, enforced at the schema.
   */
  it("rejects more than one write step", () => {
    const twoWrites: Skill = {
      ...SKILL,
      steps: [...SKILL.steps, { id: "execute-2", label: "And again", kind: "write" }],
    };
    expect(validateSkill(twoWrites).join(" ")).toContain("at most one write step");
  });

  it("refuses to start an invalid skill", () => {
    expect(() => startRun({ ...SKILL, steps: [] }, "run-x")).toThrow(/Invalid skill/);
  });
});

describe("the happy path", () => {
  it("walks queued -> reading -> gate -> done", () => {
    const run = startRun(SKILL, "run-1");
    expect(run.state).toBe("queued");
    expect(isSettled(run)).toBe(false);

    const gated = toGate();
    expect(gated.state).toBe("awaiting_signature");
    expect(gated.gate?.stepId).toBe("execute");
    expect(gated.steps.find((s) => s.id === "execute")!.status).toBe("gate");

    const done = advance(gated, { type: "approve", signature: SIG });
    expect(done.state).toBe("done");
    expect(done.signature).toBe(SIG);
    expect(isSettled(done)).toBe(true);
    expect(done.steps.every((s) => s.status === "done")).toBe(true);
  });

  it("marks the first step running as soon as the run begins", () => {
    const run = advance(startRun(SKILL, "run-1"), { type: "begin" });
    expect(run.steps[0]!.status).toBe("running");
    expect(run.steps[1]!.status).toBe("pending");
  });

  it("advances the running marker as steps finish", () => {
    let run = advance(startRun(SKILL, "run-1"), { type: "begin" });
    run = advance(run, { type: "step_done", stepId: "read-positions", detail: "12 positions" });
    expect(run.steps[0]!.status).toBe("done");
    expect(run.steps[0]!.detail).toBe("12 positions");
    expect(run.steps[1]!.status).toBe("running");
  });

  it("keeps an audit line for every transition", () => {
    const done = advance(toGate(), { type: "approve", signature: SIG });
    expect(done.log.length).toBeGreaterThanOrEqual(6);
    expect(done.log.at(-1)!.message).toContain(SIG);
  });
});

describe("rejection", () => {
  it("blocks the gated step and skips the rest", () => {
    const rejected = advance(toGate(), { type: "reject", note: "health factor too low" });
    expect(rejected.state).toBe("rejected");
    expect(rejected.rejectedNote).toBe("health factor too low");
    expect(rejected.steps.find((s) => s.id === "execute")!.status).toBe("blocked");
    expect(rejected.signature).toBeUndefined();
  });

  it("records that nothing was sent", () => {
    const rejected = advance(toGate(), { type: "reject" });
    expect(rejected.log.at(-1)!.message).toContain("Nothing was sent");
  });
});

describe("transitions that must not be possible", () => {
  it("cannot approve a run that is not at a gate", () => {
    const reading = advance(startRun(SKILL, "run-1"), { type: "begin" });
    expect(() => advance(reading, { type: "approve", signature: SIG })).toThrow(InvalidTransition);
  });

  it("cannot approve a queued run", () => {
    expect(() => advance(startRun(SKILL, "run-1"), { type: "approve", signature: SIG })).toThrow(
      InvalidTransition,
    );
  });

  /** Double-approval is a replayed signature. It must throw, not no-op. */
  it("cannot approve the same gate twice", () => {
    const done = advance(toGate(), { type: "approve", signature: SIG });
    expect(() => advance(done, { type: "approve", signature: SIG })).toThrow(InvalidTransition);
  });

  it("cannot reject after approving", () => {
    const done = advance(toGate(), { type: "approve", signature: SIG });
    expect(() => advance(done, { type: "reject" })).toThrow(InvalidTransition);
  });

  it("cannot approve after rejecting", () => {
    const rejected = advance(toGate(), { type: "reject" });
    expect(() => advance(rejected, { type: "approve", signature: SIG })).toThrow(InvalidTransition);
  });

  it("cannot open a gate on a read step", () => {
    const reading = advance(startRun(SKILL, "run-1"), { type: "begin" });
    expect(() =>
      advance(reading, { type: "gate_opened", stepId: "read-positions", decision: DECISION }),
    ).toThrow(/read step/);
  });

  it("cannot open a gate on a step that does not exist", () => {
    const reading = advance(startRun(SKILL, "run-1"), { type: "begin" });
    expect(() =>
      advance(reading, { type: "gate_opened", stepId: "nope", decision: DECISION }),
    ).toThrow(/Unknown step/);
  });

  it("cannot begin twice", () => {
    const reading = advance(startRun(SKILL, "run-1"), { type: "begin" });
    expect(() => advance(reading, { type: "begin" })).toThrow(InvalidTransition);
  });

  it("cannot fail a settled run", () => {
    const done = advance(toGate(), { type: "approve", signature: SIG });
    expect(() => advance(done, { type: "fail", error: "boom" })).toThrow(InvalidTransition);
  });

  it("does not mutate the run it was given", () => {
    const gated = toGate();
    const before = JSON.stringify(gated, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    advance(gated, { type: "approve", signature: SIG });
    expect(JSON.stringify(gated, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(before);
  });
});

describe("credits", () => {
  it("charges for reads and for composing the transaction", () => {
    let run = advance(startRun(SKILL, "run-1"), { type: "begin" });
    run = advance(run, { type: "step_done", stepId: "read-positions" });
    run = advance(run, { type: "step_done", stepId: "find-rewards" });
    expect(run.creditsUsed).toBe(CREDIT_COST.readStep * 2);
  });

  /** Stated on the pricing page: reviewing and resolving a gate is never metered. */
  it("never charges for the gate", () => {
    const gated = toGate();
    const creditsAtGate = gated.creditsUsed;

    expect(CREDIT_COST.gate).toBe(0);
    expect(advance(gated, { type: "approve", signature: SIG }).creditsUsed).toBe(creditsAtGate);
    expect(advance(gated, { type: "reject" }).creditsUsed).toBe(creditsAtGate);
  });

  it("does not refund credits when a run is rejected", () => {
    // The reading work was really done, so it is really charged.
    const rejected = advance(toGate(), { type: "reject" });
    expect(rejected.creditsUsed).toBe(CREDIT_COST.readStep * 3);
  });
});

describe("failure", () => {
  it("blocks the running step and records why", () => {
    const reading = advance(startRun(SKILL, "run-1"), { type: "begin" });
    const failed = advance(reading, { type: "fail", error: "RPC timed out" });
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("RPC timed out");
    expect(failed.steps[0]!.status).toBe("blocked");
    expect(isSettled(failed)).toBe(true);
  });
});
