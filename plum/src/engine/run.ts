/**
 * Skills and the run state machine.
 *
 * A run is a reducer: `advance(run, event)` returns a new run or throws. It
 * throws rather than ignoring an invalid transition on purpose — the transitions
 * that must not happen are "approve a run that is not at a gate" and "approve
 * the same gate twice", and both are ways money moves when it should not. A
 * silent no-op would make those bugs invisible.
 */

import type { GateDecision, Hex } from "./types";

export type StepKind = "read" | "write";

export interface SkillStep {
  id: string;
  label: string;
  kind: StepKind;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  steps: SkillStep[];
}

export type RunState =
  | "queued"
  | "reading"
  | "awaiting_signature"
  | "done"
  | "rejected"
  | "failed";

export type StepStatus = "pending" | "running" | "done" | "gate" | "blocked" | "skipped";

export interface RunStep extends SkillStep {
  status: StepStatus;
  detail?: string;
}

export interface RunLogEntry {
  at: number;
  message: string;
}

export interface Run {
  id: string;
  skillId: string;
  state: RunState;
  steps: RunStep[];
  gate?: { stepId: string; decision: GateDecision };
  creditsUsed: number;
  signature?: Hex;
  rejectedNote?: string;
  error?: string;
  log: RunLogEntry[];
}

/** Credits are spent on companion work. Reviewing a gate is deliberately free. */
export const CREDIT_COST = {
  readStep: 12,
  composeTransaction: 30,
  /** Opening, reading and resolving a gate costs nothing, ever. */
  gate: 0,
} as const;

export class InvalidTransition extends Error {
  constructor(from: RunState, event: string) {
    super(`Cannot ${event} a run in state "${from}".`);
    this.name = "InvalidTransition";
  }
}

export function validateSkill(skill: Skill): string[] {
  const problems: string[] = [];
  if (!skill.steps.length) problems.push("A skill needs at least one step.");

  const ids = new Set<string>();
  for (const step of skill.steps) {
    if (ids.has(step.id)) problems.push(`Duplicate step id "${step.id}".`);
    ids.add(step.id);
  }

  const writes = skill.steps.filter((s) => s.kind === "write");
  if (writes.length > 1) {
    // More than one write per skill would mean a second gate hidden behind the
    // first. Splitting them into separate runs keeps one signature per run.
    problems.push(
      `A skill may contain at most one write step; "${skill.id}" has ${writes.length}. Split it into separate skills so each signature is its own run.`,
    );
  }
  return problems;
}

export function startRun(skill: Skill, runId: string, now = Date.now()): Run {
  const problems = validateSkill(skill);
  if (problems.length) throw new Error(`Invalid skill: ${problems.join(" ")}`);

  return {
    id: runId,
    skillId: skill.id,
    state: "queued",
    steps: skill.steps.map((s) => ({ ...s, status: "pending" })),
    creditsUsed: 0,
    log: [{ at: now, message: `Run ${runId} queued for skill ${skill.id}.` }],
  };
}

export type RunEvent =
  | { type: "begin" }
  | { type: "step_done"; stepId: string; detail?: string }
  | { type: "gate_opened"; stepId: string; decision: GateDecision }
  | { type: "approve"; signature: Hex }
  | { type: "reject"; note?: string }
  | { type: "fail"; error: string };

export function advance(run: Run, event: RunEvent, now = Date.now()): Run {
  const log = (message: string): RunLogEntry[] => [...run.log, { at: now, message }];

  switch (event.type) {
    case "begin": {
      if (run.state !== "queued") throw new InvalidTransition(run.state, "begin");
      const steps = run.steps.map((s, i) => (i === 0 ? { ...s, status: "running" as StepStatus } : s));
      return { ...run, state: "reading", steps, log: log("Companion started reading.") };
    }

    case "step_done": {
      if (run.state !== "reading") throw new InvalidTransition(run.state, "complete a step in");
      const index = run.steps.findIndex((s) => s.id === event.stepId);
      if (index === -1) throw new Error(`Unknown step "${event.stepId}".`);

      const steps = run.steps.slice();
      const step = steps[index]!;
      steps[index] = {
        ...step,
        status: "done",
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
      };
      const next = steps[index + 1];
      if (next && next.status === "pending") {
        steps[index + 1] = { ...next, status: "running" };
      }

      const cost = step.kind === "write" ? CREDIT_COST.composeTransaction : CREDIT_COST.readStep;

      return {
        ...run,
        steps,
        creditsUsed: run.creditsUsed + cost,
        log: log(`Step "${step.label}" finished.`),
      };
    }

    case "gate_opened": {
      if (run.state !== "reading") throw new InvalidTransition(run.state, "open a gate on");
      const index = run.steps.findIndex((s) => s.id === event.stepId);
      if (index === -1) throw new Error(`Unknown step "${event.stepId}".`);
      if (run.steps[index]!.kind !== "write") {
        throw new Error(`Step "${event.stepId}" is a read step and cannot open a gate.`);
      }

      const steps = run.steps.slice();
      steps[index] = { ...steps[index]!, status: "gate" };

      return {
        ...run,
        state: "awaiting_signature",
        gate: { stepId: event.stepId, decision: event.decision },
        steps,
        // Reviewing the gate is free.
        creditsUsed: run.creditsUsed + CREDIT_COST.gate,
        log: log("Gate opened. Waiting for a human signature."),
      };
    }

    case "approve": {
      if (run.state !== "awaiting_signature") throw new InvalidTransition(run.state, "approve");
      const gateStepId = run.gate?.stepId;
      const steps = run.steps.map((s) =>
        s.id === gateStepId
          ? { ...s, status: "done" as StepStatus }
          : s.status === "pending"
            ? { ...s, status: "done" as StepStatus }
            : s,
      );
      return {
        ...run,
        state: "done",
        steps,
        signature: event.signature,
        log: log(`Signed by the user: ${event.signature}.`),
      };
    }

    case "reject": {
      if (run.state !== "awaiting_signature") throw new InvalidTransition(run.state, "reject");
      const gateStepId = run.gate?.stepId;
      const steps = run.steps.map((s) =>
        s.id === gateStepId
          ? { ...s, status: "blocked" as StepStatus }
          : s.status === "pending"
            ? { ...s, status: "skipped" as StepStatus }
            : s,
      );
      return {
        ...run,
        state: "rejected",
        steps,
        ...(event.note !== undefined ? { rejectedNote: event.note } : {}),
        log: log("Rejected by the user. Nothing was sent."),
      };
    }

    case "fail": {
      if (run.state === "done" || run.state === "rejected") {
        throw new InvalidTransition(run.state, "fail");
      }
      const steps = run.steps.map((s) =>
        s.status === "running" ? { ...s, status: "blocked" as StepStatus } : s,
      );
      return { ...run, state: "failed", steps, error: event.error, log: log(`Failed: ${event.error}`) };
    }
  }
}

/** True once a run can no longer move. */
export function isSettled(run: Run): boolean {
  return run.state === "done" || run.state === "rejected" || run.state === "failed";
}
