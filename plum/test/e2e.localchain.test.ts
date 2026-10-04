/**
 * End-to-end simulation against a real EVM.
 *
 * This is the test that matters most, because it is the only one that exercises
 * the actual claim: take real calldata, simulate it against real state, and
 * produce a diff and a risk verdict that match what would really happen.
 * Everything else in the suite works on fixtures.
 *
 * It needs a dev node with snapshot support:
 *
 *   npx hardhat node
 *
 * If one is not running the test SKIPS with an explanation rather than failing —
 * a missing dev node is an environment gap, not a regression. It never runs
 * against a public RPC: `evm_snapshot` would fail there anyway, but the guard on
 * chainId 31337 makes that explicit.
 */

import { describe, expect, it } from "vitest";
import { encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { readFileSync } from "node:fs";
import { SnapshotSimulator, UnavailableSimulator, rpc } from "../src/chain/simulator";
import { decideGate } from "../src/engine/risk";
import { MAX_UINT256 } from "../src/engine/types";

// Named RPC_URL, not URL: a const called URL shadows the global URL
// constructor used just below, and `new URL(...)` then fails at runtime.
const RPC_URL = process.env.PLUM_RPC_URL ?? "http://127.0.0.1:8545";

const artifact = JSON.parse(
  readFileSync(new URL("../contracts/TestToken.json", import.meta.url), "utf8"),
) as { bytecode: Hex; abi: Abi };

let available = false;
let setupError = "";
let accounts: Address[] = [];
let token: Address;
let alice: Address;
let router: Address;

async function deployToken(from: Address): Promise<Address> {
  const hash = await rpc<Hex>(RPC_URL, "eth_sendTransaction", [{ from, data: artifact.bytecode }]);
  const receipt = await rpc<{ contractAddress: Address } | null>(
    RPC_URL,
    "eth_getTransactionReceipt",
    [hash],
  );
  if (!receipt?.contractAddress) throw new Error("Token deployment returned no address.");
  return receipt.contractAddress;
}

/**
 * Setup runs at TOP LEVEL, not in `beforeAll`, and that is load-bearing.
 *
 * A describe body executes during collection, which happens before `beforeAll`.
 * Choosing between `it` and `it.skip` from a flag that `beforeAll` sets means
 * reading it while it is still false, so every test silently skips and the suite
 * still reports green. Awaiting here means the flag is known before collection
 * reaches the describe.
 */
try {
  const chainId = await rpc<Hex>(RPC_URL, "eth_chainId");
  if (BigInt(chainId) !== 31337n) {
    throw new Error(`Refusing to run against chain ${BigInt(chainId)} — expected a dev node (31337).`);
  }
  accounts = await rpc<Address[]>(RPC_URL, "eth_accounts");
  alice = accounts[0]!;
  router = accounts[1]!;
  token = await deployToken(alice);
  available = true;
} catch (e) {
  available = false;
  setupError = e instanceof Error ? e.message : String(e);
}

const maybe = it.runIf(available);

describe("simulating against a real EVM", () => {
  it("reports whether the dev node was reachable", () => {
    if (!available) {
      console.warn(
        `\n  SKIPPED: no usable dev node at ${RPC_URL} (${setupError}). Start one with \`npx hardhat node\`.\n`,
      );
    }
    expect(true).toBe(true);
  });

  maybe("produces a real balance diff for a real ERC-20 transfer", async () => {
    const simulator = new SnapshotSimulator(RPC_URL);

    const outcome = await simulator.simulate({
      from: alice,
      to: token,
      data: encodeFunctionData({
        abi: artifact.abi,
        functionName: "transfer",
        args: [router, 250_000000n],
      }),
      chainId: 31337,
      watched: [alice],
    });

    expect(outcome.status).toBe("success");
    expect(outcome.adapter).toBe("snapshot-revert");
    // Real logs from real execution, not a fixture.
    expect(outcome.logs.length).toBeGreaterThan(0);
    expect(outcome.gasUsed).toBeGreaterThan(0n);

    const gate = decideGate({ outcome, watched: [alice] });

    expect(gate.requiresSignature).toBe(true);
    expect(gate.trustworthy).toBe(true);

    const tokenRow = gate.deltas.find((d) => d.kind === "erc20")!;
    expect(tokenRow.delta).toBe(-250_000000n);
    expect(tokenRow.token!.toLowerCase()).toBe(token.toLowerCase());

    // Gas is real and on its own row.
    const gasRow = gate.deltas.find((d) => d.reason === "gas")!;
    expect(gasRow.delta).toBeLessThan(0n);
    expect(-gasRow.delta).toBe(outcome.gasUsed * outcome.gasPrice);
  });

  maybe("catches an unlimited approval in real calldata", async () => {
    const simulator = new SnapshotSimulator(RPC_URL);

    const outcome = await simulator.simulate({
      from: alice,
      to: token,
      data: encodeFunctionData({
        abi: artifact.abi,
        functionName: "approve",
        args: [router, MAX_UINT256],
      }),
      chainId: 31337,
      watched: [alice],
    });

    const gate = decideGate({ outcome, watched: [alice] });

    expect(gate.severity).toBe("danger");
    expect(gate.approvals[0]!.scope).toEqual({ kind: "unlimited" });
    expect(gate.approvals[0]!.spender.toLowerCase()).toBe(router.toLowerCase());
    expect(gate.findings.map((f) => f.code)).toContain("unlimited_approval");
  });

  maybe("reads a capped approval as exact", async () => {
    const simulator = new SnapshotSimulator(RPC_URL);
    const outcome = await simulator.simulate({
      from: alice,
      to: token,
      data: encodeFunctionData({
        abi: artifact.abi,
        functionName: "approve",
        args: [router, 1_284_120000n],
      }),
      chainId: 31337,
      watched: [alice],
    });

    const gate = decideGate({ outcome, watched: [alice] });
    expect(gate.approvals[0]!.scope).toEqual({ kind: "exact", amount: 1_284_120000n });
    expect(gate.findings.map((f) => f.code)).not.toContain("unlimited_approval");
  });

  maybe("reports a revert instead of a diff when the transfer cannot succeed", async () => {
    const simulator = new SnapshotSimulator(RPC_URL);
    const broke = accounts[2]!; // holds no ptUSD

    const outcome = await simulator.simulate({
      from: broke,
      to: token,
      data: encodeFunctionData({
        abi: artifact.abi,
        functionName: "transfer",
        args: [router, 1n],
      }),
      chainId: 31337,
      watched: [broke],
    });

    expect(outcome.status).toBe("reverted");

    const gate = decideGate({ outcome, watched: [broke] });
    expect(gate.trustworthy).toBe(false);
    expect(gate.findings.map((f) => f.code)).toContain("simulation_reverted");
    // Still gated, even though signing it would achieve nothing.
    expect(gate.requiresSignature).toBe(true);
  });

  maybe("captures native movement authoritatively, including gas", async () => {
    const simulator = new SnapshotSimulator(RPC_URL);
    const oneEth = 1_000_000_000_000_000_000n;

    const outcome = await simulator.simulate({
      from: alice,
      to: router,
      value: oneEth,
      chainId: 31337,
      watched: [alice, router],
    });

    expect(outcome.status).toBe("success");
    expect(outcome.nativeBalances).toBeDefined();

    const gate = decideGate({ outcome, watched: [alice, router] });

    const sent = gate.deltas.find(
      (d) => d.kind === "native" && d.reason === "sent" && d.account.toLowerCase() === alice.toLowerCase(),
    )!;
    const received = gate.deltas.find(
      (d) => d.kind === "native" && d.reason === "received" && d.account.toLowerCase() === router.toLowerCase(),
    )!;
    const gas = gate.deltas.find((d) => d.reason === "gas")!;

    expect(sent.delta).toBe(-oneEth);
    expect(received.delta).toBe(oneEth);

    // The two rows must reconcile exactly with the real on-chain balance change.
    const real = outcome.nativeBalances![alice]!;
    expect(sent.delta + gas.delta).toBe(real.post - real.pre);
  });

  /**
   * The safety property of the simulator itself: simulating must leave the
   * chain exactly as it was. If the revert ever stopped working, every later
   * simulation in a session would be computed against dirty state.
   */
  maybe("leaves the chain untouched", async () => {
    const simulator = new SnapshotSimulator(RPC_URL);

    const before = {
      block: await rpc<Hex>(RPC_URL, "eth_blockNumber"),
      balance: await rpc<Hex>(RPC_URL, "eth_getBalance", [alice, "latest"]),
      nonce: await rpc<Hex>(RPC_URL, "eth_getTransactionCount", [alice, "latest"]),
    };

    await simulator.simulate({
      from: alice,
      to: token,
      data: encodeFunctionData({
        abi: artifact.abi,
        functionName: "transfer",
        args: [router, 500_000000n],
      }),
      chainId: 31337,
      watched: [alice],
    });

    expect(await rpc<Hex>(RPC_URL, "eth_blockNumber")).toBe(before.block);
    expect(await rpc<Hex>(RPC_URL, "eth_getBalance", [alice, "latest"])).toBe(before.balance);
    expect(await rpc<Hex>(RPC_URL, "eth_getTransactionCount", [alice, "latest"])).toBe(before.nonce);
  });

  maybe("rewinds even when the simulated call reverts", async () => {
    const simulator = new SnapshotSimulator(RPC_URL);
    const before = await rpc<Hex>(RPC_URL, "eth_blockNumber");

    await simulator.simulate({
      from: accounts[3]!,
      to: token,
      data: encodeFunctionData({
        abi: artifact.abi,
        functionName: "transfer",
        args: [router, 1n],
      }),
      chainId: 31337,
      watched: [accounts[3]!],
    });

    expect(await rpc<Hex>(RPC_URL, "eth_blockNumber")).toBe(before);
  });
});

describe("when simulation is not possible", () => {
  it("says so rather than inventing a diff", async () => {
    const simulator = new UnavailableSimulator("This chain has no simulation endpoint.");
    const outcome = await simulator.simulate({
      from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      chainId: 999999,
      watched: [],
    });

    const gate = decideGate({ outcome, watched: [] });
    expect(gate.trustworthy).toBe(false);
    expect(gate.deltas).toEqual([]);
    expect(gate.requiresSignature).toBe(true);
    expect(gate.findings[0]!.detail).toContain("no simulation endpoint");
  });
});
