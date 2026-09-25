/**
 * Log decoding.
 *
 * ERC-20 and ERC-721 `Transfer` share the same topic0 — the signatures are
 * byte-identical (`Transfer(address,address,uint256)`). They are told apart by
 * shape, and getting this wrong is not cosmetic: reading an NFT transfer as a
 * token transfer would report a token balance change of `tokenId` base units,
 * which for a high token id is an absurd number shown to someone about to sign.
 *
 *   ERC-20 : 3 topics [sig, from, to] + 32 bytes of data (the value)
 *   ERC-721: 4 topics [sig, from, to, tokenId] + empty data
 *
 * Event selectors are derived with viem rather than pasted in, so a typo cannot
 * silently disable a check. `test/decode.test.ts` pins them to their canonical
 * values so a viem change cannot silently move them either.
 */

import { getAddress, hexToBigInt, toEventSelector } from "viem";
import { MAX_UINT256, type Address, type ApprovalScope, type Hex, type RawLog } from "./types";

export const TOPIC = {
  transfer: toEventSelector("Transfer(address,address,uint256)"),
  approval: toEventSelector("Approval(address,address,uint256)"),
  approvalForAll: toEventSelector("ApprovalForAll(address,address,bool)"),
} as const;

/** Pull a 20-byte address out of a 32-byte indexed topic. */
function addressFromTopic(topic: Hex | undefined): Address | null {
  if (!topic || topic.length !== 66) return null;
  return getAddress(`0x${topic.slice(26)}`) as Address;
}

export interface TokenTransfer {
  standard: "erc20" | "erc721";
  token: Address;
  from: Address;
  to: Address;
  /** Base units for erc20. */
  value?: bigint;
  /** Present for erc721. */
  tokenId?: bigint;
}

export function decodeTransfer(log: RawLog): TokenTransfer | null {
  if (log.topics[0] !== TOPIC.transfer) return null;

  const from = addressFromTopic(log.topics[1]);
  const to = addressFromTopic(log.topics[2]);
  if (!from || !to) return null;

  // 4 topics => the third indexed parameter is a tokenId, so this is an NFT.
  if (log.topics.length === 4) {
    const idTopic = log.topics[3];
    if (!idTopic) return null;
    return {
      standard: "erc721",
      token: getAddress(log.address) as Address,
      from,
      to,
      tokenId: hexToBigInt(idTopic),
    };
  }

  if (log.topics.length !== 3) return null;
  // A 32-byte value is required. Anything else is not an ERC-20 Transfer.
  if (!log.data || log.data === "0x" || log.data.length !== 66) return null;

  return {
    standard: "erc20",
    token: getAddress(log.address) as Address,
    from,
    to,
    value: hexToBigInt(log.data),
  };
}

/**
 * Classify an approval amount.
 *
 * `MAX_UINT256` is the canonical unlimited value, but plenty of contracts and
 * front-ends use a slightly smaller absurd number instead. Anything at or above
 * 2^255 is more than the supply of any real token by many orders of magnitude,
 * so it is treated as unlimited too — being conservative here means over-warning,
 * which is the right direction to be wrong in.
 */
export function classifyApprovalAmount(amount: bigint): ApprovalScope {
  if (amount === 0n) return { kind: "revoked" };
  if (amount === MAX_UINT256 || amount >= 1n << 255n) return { kind: "unlimited" };
  return { kind: "exact", amount };
}

export interface ApprovalLog {
  standard: "erc20" | "erc721";
  token: Address;
  owner: Address;
  spender: Address;
  scope: ApprovalScope;
}

export function decodeApproval(log: RawLog): ApprovalLog | null {
  const topic0 = log.topics[0];

  if (topic0 === TOPIC.approvalForAll) {
    const owner = addressFromTopic(log.topics[1]);
    const spender = addressFromTopic(log.topics[2]);
    if (!owner || !spender) return null;
    // bool in data: zero means it was revoked.
    const enabled = !!log.data && log.data !== "0x" && hexToBigInt(log.data) !== 0n;
    return {
      standard: "erc721",
      token: getAddress(log.address) as Address,
      owner,
      spender,
      scope: enabled ? { kind: "all" } : { kind: "revoked" },
    };
  }

  if (topic0 !== TOPIC.approval) return null;

  const owner = addressFromTopic(log.topics[1]);
  const spender = addressFromTopic(log.topics[2]);
  if (!owner || !spender) return null;

  // Same shape split as Transfer: 4 topics means a tokenId, not an amount.
  if (log.topics.length === 4) {
    return {
      standard: "erc721",
      token: getAddress(log.address) as Address,
      owner,
      spender,
      scope: { kind: "exact", amount: 1n },
    };
  }

  if (log.topics.length !== 3) return null;
  if (!log.data || log.data === "0x" || log.data.length !== 66) return null;

  return {
    standard: "erc20",
    token: getAddress(log.address) as Address,
    owner,
    spender,
    scope: classifyApprovalAmount(hexToBigInt(log.data)),
  };
}
