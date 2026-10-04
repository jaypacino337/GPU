/**
 * Chain adapters.
 *
 * `Simulator` is a port with three implementations, because how well you can
 * simulate depends entirely on what the RPC supports:
 *
 *   SnapshotSimulator  — snapshot, execute for real, read balances, revert.
 *                        The most accurate: real logs, real gas, real balances,
 *                        including anything inner calls moved. Needs a node you
 *                        control (a local dev chain or a fork).
 *   SimulateV1Simulator— `eth_simulateV1`, the standard method. Works against
 *                        public RPCs that support it.
 *   UnavailableSimulator — returns status "unavailable" with a reason.
 *
 * The last one is the point of the design. A gate that cannot simulate says so
 * and shows no diff, rather than showing a confident-looking diff derived from
 * guesswork. `decideGate` turns that into a danger-level finding.
 */

import type { Address, Hex, RawLog, SimulationOutcome } from "../engine/types";

export interface SimulationRequest {
  from: Address;
  to?: Address;
  data?: Hex;
  value?: bigint;
  chainId: number;
  /** Addresses whose balances should be read before and after. */
  watched: readonly Address[];
}

export interface Simulator {
  readonly name: string;
  simulate(request: SimulationRequest): Promise<SimulationOutcome>;
}

// --------------------------------------------------------------------- rpc

export class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

export async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new RpcError(`${method}: HTTP ${response.status}`);

  const json = (await response.json()) as {
    result?: T;
    error?: { message?: string; code?: number; data?: unknown };
  };
  if (json.error) {
    throw new RpcError(json.error.message ?? `${method} failed`, json.error.code, json.error.data);
  }
  return json.result as T;
}

const hex = (v: bigint): Hex => `0x${v.toString(16)}`;
const big = (v: string | undefined): bigint => (v ? BigInt(v) : 0n);

// ----------------------------------------------------------- unavailable

export class UnavailableSimulator implements Simulator {
  readonly name = "unavailable";
  constructor(private readonly reason: string) {}

  async simulate(request: SimulationRequest): Promise<SimulationOutcome> {
    return {
      status: "unavailable",
      unavailableReason: this.reason,
      logs: [],
      gasUsed: 0n,
      gasPrice: 0n,
      value: request.value ?? 0n,
      from: request.from,
      ...(request.to ? { to: request.to } : {}),
      chainId: request.chainId,
      adapter: this.name,
    };
  }
}

// -------------------------------------------------------------- snapshot

interface Receipt {
  status: Hex;
  gasUsed: Hex;
  effectiveGasPrice?: Hex;
  logs: Array<{ address: Address; topics: Hex[]; data: Hex }>;
}

/**
 * Executes the transaction for real against a node we control, then rewinds.
 *
 * Accuracy is the whole reason this exists: the logs are the logs the
 * transaction actually emits, and the balances are read from state rather than
 * inferred, so ETH moved by an inner call is captured too.
 *
 * The revert is in a `finally`, so a throw mid-simulation cannot leave the node
 * advanced past where it started.
 */
export class SnapshotSimulator implements Simulator {
  readonly name = "snapshot-revert";
  constructor(private readonly url: string) {}

  async simulate(request: SimulationRequest): Promise<SimulationOutcome> {
    const snapshotId = await rpc<string>(this.url, "evm_snapshot");

    try {
      const pre = await this.balances(request.watched);

      // Impersonation lets a companion simulate from the user's address without
      // ever holding a key for it. On a dev node this is a cheat code; against a
      // fork it is exactly the right primitive.
      await rpc(this.url, "hardhat_impersonateAccount", [request.from]).catch(() => {});

      const tx: Record<string, string> = { from: request.from };
      if (request.to) tx.to = request.to;
      if (request.data) tx.data = request.data;
      if (request.value !== undefined && request.value > 0n) tx.value = hex(request.value);

      let hash: Hex;
      try {
        hash = await rpc<Hex>(this.url, "eth_sendTransaction", [tx]);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return {
          status: "reverted",
          revertReason: reason,
          logs: [],
          gasUsed: 0n,
          gasPrice: 0n,
          value: request.value ?? 0n,
          from: request.from,
          ...(request.to ? { to: request.to } : {}),
          chainId: request.chainId,
          adapter: this.name,
        };
      }

      const receipt = await rpc<Receipt | null>(this.url, "eth_getTransactionReceipt", [hash]);
      if (!receipt) throw new RpcError("The node accepted the transaction but returned no receipt.");

      const post = await this.balances(request.watched);

      const nativeBalances: Record<string, { pre: bigint; post: bigint }> = {};
      for (const address of request.watched) {
        nativeBalances[address] = {
          pre: pre[address.toLowerCase()] ?? 0n,
          post: post[address.toLowerCase()] ?? 0n,
        };
      }

      const logs: RawLog[] = receipt.logs.map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
      }));

      const reverted = BigInt(receipt.status) === 0n;

      return {
        status: reverted ? "reverted" : "success",
        ...(reverted ? { revertReason: "The transaction executed but reverted." } : {}),
        logs,
        gasUsed: big(receipt.gasUsed),
        gasPrice: big(receipt.effectiveGasPrice),
        value: request.value ?? 0n,
        from: request.from,
        ...(request.to ? { to: request.to } : {}),
        nativeBalances,
        chainId: request.chainId,
        adapter: this.name,
      };
    } finally {
      // Always rewind, even if something above threw.
      await rpc(this.url, "evm_revert", [snapshotId]).catch(() => {});
    }
  }

  private async balances(addresses: readonly Address[]): Promise<Record<string, bigint>> {
    const out: Record<string, bigint> = {};
    for (const address of addresses) {
      out[address.toLowerCase()] = big(
        await rpc<Hex>(this.url, "eth_getBalance", [address, "latest"]),
      );
    }
    return out;
  }
}

// ------------------------------------------------------------ simulateV1

interface SimulateV1Call {
  status: Hex;
  gasUsed: Hex;
  logs?: Array<{ address: Address; topics: Hex[]; data: Hex }>;
  error?: { message?: string };
}

/**
 * `eth_simulateV1` — the standard simulation method (Geth 1.14+).
 *
 * NOT exercised by the test suite: the local dev node used for the end-to-end
 * test does not implement this method, and no public RPC is reachable from the
 * build environment. Treat it as unverified until it has run against a real
 * endpoint. It falls back to "unavailable" when the method is missing, which is
 * the behaviour that matters most and IS covered by a test.
 */
export class SimulateV1Simulator implements Simulator {
  readonly name = "eth_simulateV1";
  constructor(private readonly url: string) {}

  async simulate(request: SimulationRequest): Promise<SimulationOutcome> {
    const call: Record<string, string> = { from: request.from };
    if (request.to) call.to = request.to;
    if (request.data) call.data = request.data;
    if (request.value !== undefined && request.value > 0n) call.value = hex(request.value);

    const payload = {
      blockStateCalls: [{ calls: [call] }],
      validation: true,
      traceTransfers: true,
    };

    let blocks: Array<{ calls: SimulateV1Call[] }>;
    try {
      blocks = await rpc(this.url, "eth_simulateV1", [payload, "latest"]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return new UnavailableSimulator(
        `This RPC does not support eth_simulateV1 (${message}), so there is no balance diff for this transaction.`,
      ).simulate(request);
    }

    const result = blocks[0]?.calls[0];
    if (!result) {
      return new UnavailableSimulator(
        "The RPC returned no simulation result for this transaction.",
      ).simulate(request);
    }

    const reverted = BigInt(result.status) === 0n;
    let gasPrice = 0n;
    try {
      gasPrice = big(await rpc<Hex>(this.url, "eth_gasPrice"));
    } catch {
      // A missing gas price costs us the fee line, not the diff.
    }

    return {
      status: reverted ? "reverted" : "success",
      ...(reverted ? { revertReason: result.error?.message ?? "The transaction reverted." } : {}),
      logs: (result.logs ?? []).map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
      gasUsed: big(result.gasUsed),
      gasPrice,
      value: request.value ?? 0n,
      from: request.from,
      ...(request.to ? { to: request.to } : {}),
      chainId: request.chainId,
      adapter: this.name,
    };
  }
}

/**
 * Pick the best simulator an endpoint actually supports.
 * Never silently downgrades to guessing — the last resort is "unavailable".
 */
export async function pickSimulator(url: string, allowSnapshot = false): Promise<Simulator> {
  if (allowSnapshot) {
    try {
      const id = await rpc<string>(url, "evm_snapshot");
      await rpc(url, "evm_revert", [id]).catch(() => {});
      return new SnapshotSimulator(url);
    } catch {
      // Not a node we control. Fall through.
    }
  }

  try {
    await rpc(url, "eth_simulateV1", [{ blockStateCalls: [] }, "latest"]);
    return new SimulateV1Simulator(url);
  } catch (e) {
    if (e instanceof RpcError && e.code !== -32004 && e.code !== -32601) {
      // The method exists but disliked our empty payload — good enough.
      return new SimulateV1Simulator(url);
    }
  }

  return new UnavailableSimulator(
    "This RPC cannot simulate transactions, so Plum cannot show you a balance diff. You can still sign — you are just doing it with less information.",
  );
}
