/**
 * The product loop, end to end, against a real chain.
 *
 *   npx hardhat node          # terminal 1
 *   npm run demo              # terminal 2  (capped approval, then approve)
 *   npm run demo -- --unlimited --reject
 *
 * This is the whole of Plum in one file: a companion works through a skill's
 * read steps, composes a transaction, and stops. The gate simulates it, shows
 * what would really change, and waits. Nothing signs itself.
 */

import { readFileSync } from "node:fs";
import { encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { SnapshotSimulator, rpc } from "../chain/simulator";
import { decideGate } from "../engine/risk";
import { formatEth, formatGwei, formatUnits, shortAddress } from "../engine/format";
import { advance, startRun, type Skill } from "../engine/run";
import { MAX_UINT256 } from "../engine/types";

const RPC_URL = process.env.PLUM_RPC_URL ?? "http://127.0.0.1:8545";
const UNLIMITED = process.argv.includes("--unlimited");
const REJECT = process.argv.includes("--reject");

const TOKEN_DECIMALS = 6;
const TOKEN_SYMBOL = "ptUSD";
const SPEND = 1_284_120000n; // 1,284.12 ptUSD

const artifact = JSON.parse(
  readFileSync(new URL("../../contracts/TestToken.json", import.meta.url), "utf8"),
) as { bytecode: Hex; abi: Abi };

const SKILL: Skill = {
  id: "weekly-compound",
  name: "Weekly compound",
  description: "Claim rewards, then approve the router for exactly what the run spends.",
  steps: [
    { id: "read-positions", label: "Read positions across your wallets", kind: "read" },
    { id: "find-rewards", label: "Find claimable rewards", kind: "read" },
    { id: "quote", label: "Quote the best route", kind: "read" },
    { id: "approve", label: "Approve the router", kind: "write" },
  ],
};

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
  plum: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

const TONE = { info: c.dim, caution: c.amber, danger: c.red } as const;

async function deployToken(from: Address): Promise<Address> {
  const hash = await rpc<Hex>(RPC_URL, "eth_sendTransaction", [
    { from, data: artifact.bytecode },
  ]);
  const receipt = await rpc<{ contractAddress: Address } | null>(
    RPC_URL,
    "eth_getTransactionReceipt",
    [hash],
  );
  if (!receipt?.contractAddress) throw new Error("Deployment returned no contract address.");
  return receipt.contractAddress;
}

async function main() {
  let accounts: Address[];
  try {
    accounts = await rpc<Address[]>(RPC_URL, "eth_accounts");
  } catch {
    console.error(
      `\nNo dev chain at ${RPC_URL}.\nStart one with \`npx hardhat node\` and run this again.\n`,
    );
    process.exit(1);
  }

  const alice = accounts[0]!;
  const router = accounts[1]!;
  const token = await deployToken(alice);

  console.log(c.plum(`\n  plum · companion "Ledger" · skill ${SKILL.id}`));
  console.log(c.dim(`  wallet ${shortAddress(alice)} · token ${shortAddress(token)} (${TOKEN_SYMBOL})\n`));

  // ---- the read steps ----------------------------------------------------
  let run = advance(startRun(SKILL, "run-4182"), { type: "begin" });

  const details: Record<string, string> = {
    "read-positions": "4 wallets · 12 positions",
    "find-rewards": `${formatUnits(SPEND, TOKEN_DECIMALS)} ${TOKEN_SYMBOL} claimable · 3 pools`,
    quote: "Route A · 0.31% slippage · 12 bps better than direct",
  };

  for (const step of SKILL.steps) {
    if (step.kind === "write") break;
    run = advance(run, { type: "step_done", stepId: step.id, detail: details[step.id] });
    console.log(`  ${c.green("✓")} ${step.label}`);
    console.log(`    ${c.dim(details[step.id] ?? "")}`);
  }

  // ---- compose, then STOP ------------------------------------------------
  const amount = UNLIMITED ? MAX_UINT256 : SPEND;
  const data = encodeFunctionData({
    abi: artifact.abi,
    functionName: "approve",
    args: [router, amount],
  });

  const outcome = await new SnapshotSimulator(RPC_URL).simulate({
    from: alice,
    to: token,
    data,
    chainId: 31337,
    watched: [alice],
  });

  const gate = decideGate({ outcome, watched: [alice], knownSpenders: [] });
  run = advance(run, { type: "gate_opened", stepId: "approve", decision: gate });

  // ---- the gate ----------------------------------------------------------
  console.log(`\n  ${c.amber("!")} ${c.bold("Needs your signature")}  ${c.dim("— the companion stops here")}`);
  console.log(`    Approve the router for ${shortAddress(router)}`);
  console.log(c.dim(`    simulated by ${outcome.adapter} · gas ${formatEth(outcome.gasUsed * outcome.gasPrice)} at ${formatGwei(outcome.gasPrice)}`));

  console.log(`\n  ${c.bold("Simulated balance diff")}`);
  if (!gate.trustworthy) {
    console.log(`    ${c.red("unavailable — no diff to show")}`);
  } else if (gate.deltas.length === 0) {
    console.log(c.dim("    nothing moves in or out of your wallet"));
  } else {
    for (const d of gate.deltas) {
      const decimals = d.kind === "native" ? 18 : TOKEN_DECIMALS;
      const symbol = d.kind === "native" ? "ETH" : TOKEN_SYMBOL;
      const text = `${formatUnits(d.delta, decimals, { signed: true, maxFractionDigits: 6 })} ${symbol}`;
      const paint = d.delta < 0n ? c.red : c.green;
      console.log(`    ${paint(text.padEnd(26))} ${c.dim(d.reason)}`);
    }
  }

  if (gate.approvals.length) {
    console.log(`\n  ${c.bold("Approvals")}`);
    for (const a of gate.approvals) {
      const scope =
        a.scope.kind === "exact"
          ? `${formatUnits(a.scope.amount, TOKEN_DECIMALS)} ${TOKEN_SYMBOL}`
          : a.scope.kind;
      const paint = a.scope.kind === "unlimited" || a.scope.kind === "all" ? c.red : c.dim;
      console.log(`    ${shortAddress(a.spender)} → ${paint(scope)}`);
    }
  }

  console.log(`\n  ${c.bold("Findings")}`);
  for (const f of gate.findings) {
    console.log(`    ${TONE[f.severity](`[${f.severity}]`)} ${f.title}`);
    console.log(c.dim(`      ${f.detail}`));
  }

  // ---- resolve -----------------------------------------------------------
  if (REJECT) {
    run = advance(run, { type: "reject", note: "demo: rejected" });
    console.log(`\n  ${c.red("✕ Rejected.")} Nothing was sent. The chain is untouched.`);
  } else {
    // A real signature comes from the user's wallet. Nothing in this repo holds
    // a key, so this stands in for the signature coming back from one.
    run = advance(run, { type: "approve", signature: "0xdemo" as Hex });
    console.log(`\n  ${c.green("✓ Approved")} — in the real product this is where your wallet prompts.`);
    console.log(c.dim("    Plum never holds a key; it hands the transaction to your wallet to sign."));
  }

  console.log(
    c.dim(
      `\n  run ${run.id} · ${run.state} · ${run.creditsUsed} credits used (the gate itself is free)\n`,
    ),
  );
}

main().catch((e) => {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
