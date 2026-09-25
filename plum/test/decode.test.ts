import { describe, expect, it } from "vitest";
import { classifyApprovalAmount, decodeApproval, decodeTransfer, TOPIC } from "../src/engine/decode";
import { MAX_UINT256, type Address, type Hex, type RawLog } from "../src/engine/types";

const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

const topicFor = (address: string): Hex => `0x000000000000000000000000${address.slice(2).toLowerCase()}`;
const word = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}`;

function log(topics: Hex[], data: Hex = "0x"): RawLog {
  return { address: TOKEN, topics, data };
}

describe("event selectors", () => {
  // Pinned to their canonical values. Deriving them at runtime protects against
  // typos; pinning them here protects against a library change moving them.
  it("match the canonical keccak hashes", () => {
    expect(TOPIC.transfer).toBe(
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    );
    expect(TOPIC.approval).toBe(
      "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
    );
    expect(TOPIC.approvalForAll).toBe(
      "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31",
    );
  });
});

describe("decodeTransfer", () => {
  it("reads an ERC-20 transfer", () => {
    const t = decodeTransfer(log([TOPIC.transfer, topicFor(ALICE), topicFor(BOB)], word(1_284_120000n)));
    expect(t).toMatchObject({ standard: "erc20", value: 1_284_120000n });
    expect(t!.from.toLowerCase()).toBe(ALICE.toLowerCase());
    expect(t!.to.toLowerCase()).toBe(BOB.toLowerCase());
  });

  /**
   * The failure this guards against is specific and ugly: ERC-721 shares
   * Transfer's selector, so reading an NFT transfer as ERC-20 reports a balance
   * change of `tokenId` base units. For a token id like 8171 that is a nonsense
   * number shown to someone about to sign.
   */
  it("reads an ERC-721 transfer as an NFT, not as 8171 tokens", () => {
    const t = decodeTransfer(
      log([TOPIC.transfer, topicFor(ALICE), topicFor(BOB), word(8171n)]),
    );
    expect(t).toMatchObject({ standard: "erc721", tokenId: 8171n });
    expect(t!.value).toBeUndefined();
  });

  it("rejects a Transfer with a malformed value", () => {
    expect(decodeTransfer(log([TOPIC.transfer, topicFor(ALICE), topicFor(BOB)], "0x"))).toBeNull();
    expect(decodeTransfer(log([TOPIC.transfer, topicFor(ALICE), topicFor(BOB)], "0xdeadbeef"))).toBeNull();
  });

  it("rejects a Transfer missing an indexed party", () => {
    expect(decodeTransfer(log([TOPIC.transfer, topicFor(ALICE)], word(1n)))).toBeNull();
  });

  it("ignores unrelated events", () => {
    expect(decodeTransfer(log([TOPIC.approval, topicFor(ALICE), topicFor(BOB)], word(1n)))).toBeNull();
  });
});

describe("classifyApprovalAmount", () => {
  it("treats max uint256 as unlimited", () => {
    expect(classifyApprovalAmount(MAX_UINT256)).toEqual({ kind: "unlimited" });
  });

  it("treats absurd-but-not-max amounts as unlimited too", () => {
    // Plenty of front-ends approve 2^255 or similar rather than exactly max.
    // Over-warning here is the right direction to be wrong in.
    expect(classifyApprovalAmount(1n << 255n)).toEqual({ kind: "unlimited" });
    expect(classifyApprovalAmount((1n << 256n) - 2n)).toEqual({ kind: "unlimited" });
  });

  it("treats zero as a revocation", () => {
    expect(classifyApprovalAmount(0n)).toEqual({ kind: "revoked" });
  });

  it("keeps a real amount exact", () => {
    expect(classifyApprovalAmount(1_284_120000n)).toEqual({ kind: "exact", amount: 1_284_120000n });
  });
});

describe("decodeApproval", () => {
  it("reads an ERC-20 approval", () => {
    const a = decodeApproval(log([TOPIC.approval, topicFor(ALICE), topicFor(BOB)], word(500n)));
    expect(a).toMatchObject({ standard: "erc20", scope: { kind: "exact", amount: 500n } });
  });

  it("flags setApprovalForAll(true) as collection-wide", () => {
    const a = decodeApproval(log([TOPIC.approvalForAll, topicFor(ALICE), topicFor(BOB)], word(1n)));
    expect(a!.scope).toEqual({ kind: "all" });
  });

  it("reads setApprovalForAll(false) as a revocation", () => {
    const a = decodeApproval(log([TOPIC.approvalForAll, topicFor(ALICE), topicFor(BOB)], word(0n)));
    expect(a!.scope).toEqual({ kind: "revoked" });
  });

  it("reads an ERC-721 single-token approval without treating the id as an amount", () => {
    const a = decodeApproval(
      log([TOPIC.approval, topicFor(ALICE), topicFor(BOB), word(99999n)]),
    );
    expect(a).toMatchObject({ standard: "erc721", scope: { kind: "exact", amount: 1n } });
  });
});
