import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  Signer,
  SendTransactionError,
} from "@solana/web3.js";

/**
 * Simulate, then send. Never send blind.
 *
 * The spec's requirement is that the user sees the REAL error, not "transaction
 * failed" — so simulation runs first and its logs are mined for the program's
 * own error message before anything is signed.
 */

/** Human-readable messages for our program's error codes, mirroring errors.rs. */
const PROGRAM_ERRORS: Record<string, string> = {
  MintPaused: "Minting is paused right now.",
  RedeemPaused: "Sell-back is paused right now.",
  SoldOut: "All 1000 PitBrokers have been minted.",
  PhaseClosed: "Minting is not open yet.",
  InsufficientTreasury:
    "The treasury cannot cover a sell-back at the moment. Check 'redemptions available' before trying again.",
  WrongCollection: "That asset is not a PitBroker from this collection.",
  AssetNotInVault:
    "Someone else claimed that broker first. Try again — a fresh one will be picked.",
  NotAssetOwner: "You do not own that PitBroker.",
  WouldBreakFloor:
    "That withdrawal would dip into funds reserved to back outstanding sell-backs.",
  IndexAlreadyMinted: "That broker was just minted by someone else. Try again.",
  PoolExhausted: "No unminted PitBrokers remain.",
};

/**
 * Submitted, but we never learned the outcome.
 *
 * Deliberately a distinct type from TransactionFailure: the UI must NOT invite
 * a retry here, because the transaction may already have succeeded. The message
 * carries the signature so the user can check for themselves.
 */
export class UnconfirmedTransaction extends Error {
  constructor(
    readonly signature: string,
    /** True when a follow-up check found no trace of it on chain. */
    readonly likelyDropped: boolean,
  ) {
    super(
      likelyDropped
        ? `The network did not confirm your transaction in time and it does not appear ` +
          `on chain, so it most likely never landed. Check ${signature} before retrying.`
        : `Your transaction was submitted but not confirmed in time. It may still ` +
          `land — check ${signature} on the explorer before trying again, so you ` +
          `do not do it twice.`,
    );
    this.name = "UnconfirmedTransaction";
  }
}

/** One follow-up check: true = landed ok, false = definitely not there, null = unclear. */
async function didLand(
  connection: Connection,
  signature: string,
): Promise<boolean | null> {
  try {
    const status = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const value = status.value[0];
    if (!value) return false;
    if (value.err) return false;
    return value.confirmationStatus === "confirmed" ||
      value.confirmationStatus === "finalized";
  } catch {
    return null;
  }
}

export class TransactionFailure extends Error {
  constructor(
    message: string,
    readonly logs: string[] = [],
    readonly stage: "simulate" | "send" | "confirm" = "simulate",
  ) {
    super(message);
    this.name = "TransactionFailure";
  }
}

/**
 * Pull the most specific message available out of simulation logs.
 * Anchor emits `Program log: AnchorError ... Error Message: <msg>.`
 */
export function explainLogs(logs: string[] | null | undefined): string | null {
  if (!logs?.length) return null;

  for (const line of logs) {
    const named = line.match(/Error Code: (\w+)/);
    if (named?.[1] && PROGRAM_ERRORS[named[1]]) return PROGRAM_ERRORS[named[1]];

    const message = line.match(/Error Message: (.+?)\.?$/);
    if (message?.[1]) return message[1];
  }

  // Common runtime failures that never reach our error enum.
  const joined = logs.join("\n");
  if (/insufficient funds|insufficient lamports/i.test(joined)) {
    return "Not enough SOL to cover transaction fees and account rent.";
  }
  if (/insufficient/i.test(joined)) {
    return "Not enough $PUMPBROKER in your wallet for this transaction.";
  }
  if (/custom program error: 0x1\b/.test(joined)) {
    return "Not enough $PUMPBROKER in your wallet for this transaction.";
  }
  return null;
}

export interface SendOptions {
  connection: Connection;
  payer: PublicKey;
  instructions: TransactionInstruction[];
  /** Extra keypairs that must sign, e.g. the new Core asset. */
  extraSigners?: Signer[];
  signTransaction: (tx: Transaction) => Promise<Transaction>;
}

export async function simulateThenSend({
  connection,
  payer,
  instructions,
  extraSigners = [],
  signTransaction,
}: SendOptions): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const tx = new Transaction();
  tx.add(...instructions);
  tx.feePayer = payer;
  tx.recentBlockhash = blockhash;

  // Simulation first — cheaper and clearer than a failed on-chain send.
  const simulation = await connection.simulateTransaction(tx);
  if (simulation.value.err) {
    const explained =
      explainLogs(simulation.value.logs) ??
      `Simulation failed: ${JSON.stringify(simulation.value.err)}`;
    throw new TransactionFailure(explained, simulation.value.logs ?? [], "simulate");
  }

  if (extraSigners.length) tx.partialSign(...extraSigners);

  let signed: Transaction;
  try {
    signed = await signTransaction(tx);
  } catch (e) {
    // Wallet disconnect or user rejection mid-flow — distinguish the two, since
    // "rejected" is not an error the user needs to debug.
    const message = e instanceof Error ? e.message : String(e);
    if (/reject|denied|cancell?ed/i.test(message)) {
      throw new TransactionFailure("You cancelled the transaction.", [], "send");
    }
    throw new TransactionFailure(
      `Wallet could not sign: ${message}. If your wallet disconnected, reconnect and try again — nothing has been sent.`,
      [],
      "send",
    );
  }

  let signature: string;
  try {
    signature = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
  } catch (e) {
    const logs = e instanceof SendTransactionError ? await safeLogs(e) : [];
    throw new TransactionFailure(
      explainLogs(logs) ?? (e instanceof Error ? e.message : String(e)),
      logs,
      "send",
    );
  }

  try {
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    if (confirmation.value.err) {
      throw new TransactionFailure(
        `Transaction landed but failed: ${JSON.stringify(confirmation.value.err)}`,
        [],
        "confirm",
      );
    }
  } catch (e) {
    if (e instanceof TransactionFailure) throw e;

    // Timed out or the connection dropped while waiting. The transaction may
    // still land — reporting a flat failure here is how someone concludes their
    // mint failed and mints a second time. Check the chain once before deciding.
    const landed = await didLand(connection, signature);
    if (landed === true) return signature;

    throw new UnconfirmedTransaction(signature, landed === false);
  }

  return signature;
}

async function safeLogs(e: SendTransactionError): Promise<string[]> {
  try {
    return (await e.getLogs(undefined as never)) ?? [];
  } catch {
    return e.logs ?? [];
  }
}
