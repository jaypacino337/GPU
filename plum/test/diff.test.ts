import { describe, expect, it } from "vitest";
import { computeAssetDeltas, gasCost, netByAsset, totalSent } from "../src/engine/diff";
import { TOPIC } from "../src/engine/decode";
import type { Address, Hex, RawLog, SimulationOutcome } from "../src/engine/types";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD" as Address;

const topicFor = (a: string): Hex => `0x000000000000000000000000${a.slice(2).toLowerCase()}`;
const word = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}`;

function transferLog(from: string, to: string, value: bigint, token: Address = USDC): RawLog {
  return { address: token, topics: [TOPIC.transfer, topicFor(from), topicFor(to)], data: word(value) };
}

function outcome(partial: Partial<SimulationOutcome> = {}): SimulationOutcome {
  return {
    status: "success",
    logs: [],
    gasUsed: 21_000n,
    gasPrice: 1_000_000_000n, // 1 gwei
    value: 0n,
    from: ALICE,
    chainId: 8453,
    adapter: "test",
    ...partial,
  };
}

describe("computeAssetDeltas", () => {
  it("records a token outflow for the watched sender", () => {
    const deltas = computeAssetDeltas({
      outcome: outcome({ logs: [transferLog(ALICE, BOB, 250_000000n)] }),
      watched: [ALICE],
    });
    const token = deltas.find((d) => d.kind === "erc20")!;
    expect(token.delta).toBe(-250_000000n);
    expect(token.reason).toBe("sent");
  });

  it("ignores movements between addresses the user does not hold", () => {
    const deltas = computeAssetDeltas({
      outcome: outcome({ logs: [transferLog(BOB, POOL, 999n)] }),
      watched: [ALICE],
    });
    expect(deltas.filter((d) => d.kind === "erc20")).toHaveLength(0);
  });

  /**
   * Claim 1,284 then repay 1,284 nets to zero. Netting it would render as
   * "0 USDC" and hide both halves of what the transaction does, so inflow and
   * outflow stay on separate rows.
   */
  it("keeps an inflow and an outflow of the same token on separate rows", () => {
    const deltas = computeAssetDeltas({
      outcome: outcome({
        logs: [transferLog(POOL, ALICE, 1_284_120000n), transferLog(ALICE, POOL, 1_284_120000n)],
      }),
      watched: [ALICE],
    });

    const tokenRows = deltas.filter((d) => d.kind === "erc20");
    expect(tokenRows).toHaveLength(2);
    expect(tokenRows.map((r) => r.delta).sort()).toEqual([-1_284_120000n, 1_284_120000n]);

    // ...while the net is still available for a summary line.
    const net = netByAsset(tokenRows);
    expect([...net.values()]).toEqual([0n]);
  });

  it("aggregates repeated movements in the same direction", () => {
    const deltas = computeAssetDeltas({
      outcome: outcome({
        logs: [transferLog(POOL, ALICE, 100n), transferLog(POOL, ALICE, 250n), transferLog(POOL, ALICE, 7n)],
      }),
      watched: [ALICE],
    });
    const received = deltas.filter((d) => d.kind === "erc20" && d.reason === "received");
    expect(received).toHaveLength(1);
    expect(received[0]!.delta).toBe(357n);
  });

  it("puts gas on its own row", () => {
    const deltas = computeAssetDeltas({ outcome: outcome(), watched: [ALICE] });
    const gas = deltas.find((d) => d.reason === "gas")!;
    expect(gas.kind).toBe("native");
    expect(gas.delta).toBe(-21_000n * 1_000_000_000n);
  });

  it("does not charge gas to an address that is not paying for it", () => {
    const deltas = computeAssetDeltas({ outcome: outcome(), watched: [BOB] });
    expect(deltas.find((d) => d.reason === "gas")).toBeUndefined();
  });

  /**
   * Authoritative balances already have gas deducted. If that were not added
   * back, gas would be counted twice — once in the movement, once in the fee row.
   */
  it("does not double-count gas when authoritative balances are available", () => {
    const gas = 21_000n * 1_000_000_000n;
    const sent = 1_000_000_000_000_000_000n; // 1 ETH

    const deltas = computeAssetDeltas({
      outcome: outcome({
        value: sent,
        to: BOB,
        nativeBalances: {
          [ALICE]: { pre: 10n * sent, post: 10n * sent - sent - gas },
        },
      }),
      watched: [ALICE],
    });

    const movement = deltas.find((d) => d.kind === "native" && d.reason === "sent")!;
    const gasRow = deltas.find((d) => d.reason === "gas")!;

    expect(movement.delta).toBe(-sent);
    expect(gasRow.delta).toBe(-gas);
    // The two rows together must reconcile exactly with the real balance change.
    expect(movement.delta + gasRow.delta).toBe(-sent - gas);
  });

  it("falls back to the call value when no authoritative balances exist", () => {
    const deltas = computeAssetDeltas({
      outcome: outcome({ value: 5n, to: BOB }),
      watched: [ALICE, BOB],
    });
    expect(deltas.find((d) => d.kind === "native" && d.reason === "sent")!.delta).toBe(-5n);
    expect(deltas.find((d) => d.kind === "native" && d.reason === "received")!.delta).toBe(5n);
  });

  it("returns nothing when the simulation is unavailable", () => {
    const deltas = computeAssetDeltas({
      outcome: outcome({ status: "unavailable", unavailableReason: "no simulation" }),
      watched: [ALICE],
    });
    expect(deltas).toEqual([]);
  });

  it("counts an NFT as one unit, not as its token id", () => {
    const deltas = computeAssetDeltas({
      outcome: outcome({
        logs: [
          {
            address: USDC,
            topics: [TOPIC.transfer, topicFor(ALICE), topicFor(BOB), word(8171n)],
            data: "0x",
          },
        ],
      }),
      watched: [ALICE],
    });
    const nft = deltas.find((d) => d.kind === "erc721")!;
    expect(nft.delta).toBe(-1n);
    expect(nft.tokenId).toBe(8171n);
  });

  it("handles an address sending to itself without inventing a change", () => {
    const deltas = computeAssetDeltas({
      outcome: outcome({ logs: [transferLog(ALICE, ALICE, 500n)] }),
      watched: [ALICE],
    });
    const net = netByAsset(deltas.filter((d) => d.kind === "erc20"));
    expect([...net.values()]).toEqual([0n]);
  });
});

describe("totalSent", () => {
  it("sums outflows of one token and excludes gas", () => {
    const deltas = computeAssetDeltas({
      outcome: outcome({ logs: [transferLog(ALICE, POOL, 300n), transferLog(ALICE, BOB, 200n)] }),
      watched: [ALICE],
    });
    expect(totalSent(deltas, USDC)).toBe(500n);
    expect(totalSent(deltas, undefined)).toBe(0n); // native, gas excluded
  });
});

describe("gasCost", () => {
  it("multiplies without floats", () => {
    expect(gasCost(outcome({ gasUsed: 123_456n, gasPrice: 7_777_777_777n }))).toBe(
      123_456n * 7_777_777_777n,
    );
  });
});
