import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { explainLogs, TransactionFailure } from "./sendTransaction";
import { transferKey, type SnapshotRow } from "./airdropPreflight";

/**
 * Batched airdrop transfers with retry and idempotency.
 *
 * IDEMPOTENCY, and why it is shaped this way:
 *
 * A partial failure must be safely re-runnable — re-sending to someone who was
 * already paid is the worst outcome here, worse than not paying at all, because
 * it is unrecoverable. Three layers, because no single one is sufficient:
 *
 *   1. A ledger keyed by (ticker, snapshot, owner). Anything already recorded
 *      with a signature is skipped outright.
 *   2. `onProgress` fires after EVERY batch, before the next one starts, so the
 *      caller can persist the ledger incrementally. A crash mid-run loses at
 *      most the batch in flight, never the whole record.
 *   3. The ATA creation uses the *idempotent* instruction variant, so a retry
 *      cannot fail merely because the account now exists.
 *
 * What this does NOT do is guess. If a batch's outcome is unknown (timeout after
 * submission), it is recorded as `unknown` rather than success or failure, and
 * the caller is told to verify on-chain before re-running. Silently retrying an
 * unknown is how people get paid twice.
 */

/** Conservative: an ATA-create + transfer pair per recipient is ~2 instructions. */
const RECIPIENTS_PER_TX = 5;
const MAX_ATTEMPTS = 3;

export type TransferOutcome = "sent" | "skipped" | "failed" | "unknown";

export interface TransferResult {
  key: string;
  owner: string;
  amount: bigint;
  outcome: TransferOutcome;
  signature?: string;
  error?: string;
}

export interface ExecuteParams {
  connection: Connection;
  /** Admin wallet — signs, and owns the source token account. */
  payer: PublicKey;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  mint: PublicKey;
  decimals: number;
  /** Source of funds. The treasury's ATA for this mint. */
  source: PublicKey;
  /** Authority over `source`. */
  sourceAuthority: PublicKey;
  rows: SnapshotRow[];
  ticker: string;
  snapshotAt: string;
  /** Keys already completed in a previous run. */
  completed?: Set<string>;
  /** Called after every batch so the caller can persist progress. */
  onProgress?: (results: TransferResult[]) => void;
  /** Abort between batches. */
  shouldStop?: () => boolean;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function executeAirdrop(params: ExecuteParams): Promise<TransferResult[]> {
  const {
    connection,
    payer,
    signTransaction,
    mint,
    decimals,
    source,
    sourceAuthority,
    rows,
    ticker,
    snapshotAt,
    completed = new Set<string>(),
    onProgress,
    shouldStop,
  } = params;

  const all: TransferResult[] = [];

  // Layer 1: drop anything a previous run already completed.
  const pending = rows.filter(
    (row) => !completed.has(transferKey(ticker, snapshotAt, row.owner)),
  );

  for (const row of rows) {
    const key = transferKey(ticker, snapshotAt, row.owner);
    if (completed.has(key)) {
      all.push({ key, owner: row.owner, amount: row.amount, outcome: "skipped" });
    }
  }
  if (all.length) onProgress?.(all.slice());

  for (const batch of chunk(pending, RECIPIENTS_PER_TX)) {
    if (shouldStop?.()) break;

    const instructions: TransactionInstruction[] = [];
    const inBatch: Array<{ key: string; row: SnapshotRow }> = [];

    for (const row of batch) {
      const owner = new PublicKey(row.owner);
      const destination = await getAssociatedTokenAddress(mint, owner);

      // Layer 3: idempotent — a retry after partial success will not fail here.
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          destination,
          owner,
          mint,
        ),
      );
      instructions.push(
        createTransferCheckedInstruction(
          source,
          mint,
          destination,
          sourceAuthority,
          row.amount,
          decimals,
        ),
      );
      inBatch.push({ key: transferKey(ticker, snapshotAt, row.owner), row });
    }

    const result = await sendBatchWithRetry(
      connection,
      payer,
      instructions,
      signTransaction,
    );

    const batchResults: TransferResult[] = inBatch.map(({ key, row }) => ({
      key,
      owner: row.owner,
      amount: row.amount,
      outcome: result.outcome,
      signature: result.signature,
      error: result.error,
    }));

    all.push(...batchResults);
    // Layer 2: persist before starting the next batch.
    onProgress?.(all.slice());
  }

  return all;
}

async function sendBatchWithRetry(
  connection: Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[],
  signTransaction: (tx: Transaction) => Promise<Transaction>,
): Promise<{ outcome: TransferOutcome; signature?: string; error?: string }> {
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let signature: string | undefined;
    try {
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");

      const tx = new Transaction().add(...instructions);
      tx.feePayer = payer;
      tx.recentBlockhash = blockhash;

      const simulation = await connection.simulateTransaction(tx);
      if (simulation.value.err) {
        // A simulation failure is deterministic — retrying will not help.
        return {
          outcome: "failed",
          error:
            explainLogs(simulation.value.logs) ??
            `Simulation failed: ${JSON.stringify(simulation.value.err)}`,
        };
      }

      const signed = await signTransaction(tx);
      signature = await connection.sendRawTransaction(signed.serialize(), {
        preflightCommitment: "confirmed",
      });

      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      );

      if (confirmation.value.err) {
        lastError = `Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`;
        // It landed and failed — nothing was transferred, so a retry is safe.
        if (attempt < MAX_ATTEMPTS) {
          await sleep(1000 * 2 ** (attempt - 1));
          continue;
        }
        return { outcome: "failed", signature, error: lastError };
      }

      return { outcome: "sent", signature };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);

      // The dangerous case: submitted, but we never learned the outcome. Do NOT
      // retry — the transfer may already have landed. Hand it back as unknown
      // so a human verifies before anything is re-sent.
      if (signature) {
        return {
          outcome: "unknown",
          signature,
          error:
            `Submitted but not confirmed (${lastError}). Verify this signature on ` +
            "chain before re-running — it may already have paid.",
        };
      }

      if (attempt < MAX_ATTEMPTS) {
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
    }
  }

  return { outcome: "failed", error: lastError };
}

/** Ledger serialisation — committed alongside the distribution record. */
export interface AirdropLedger {
  ticker: string;
  snapshotAt: string;
  mint: string;
  entries: Array<{
    owner: string;
    amount: string;
    outcome: TransferOutcome;
    signature?: string;
    error?: string;
  }>;
}

export function toLedger(
  ticker: string,
  snapshotAt: string,
  mint: string,
  results: TransferResult[],
): AirdropLedger {
  return {
    ticker,
    snapshotAt,
    mint,
    entries: results.map((r) => ({
      owner: r.owner,
      amount: r.amount.toString(),
      outcome: r.outcome,
      signature: r.signature,
      error: r.error,
    })),
  };
}

/** Keys safe to skip on a re-run. `unknown` is deliberately NOT included. */
export function completedKeys(ledger: AirdropLedger): Set<string> {
  const keys = new Set<string>();
  for (const entry of ledger.entries) {
    if (entry.outcome === "sent" || entry.outcome === "skipped") {
      keys.add(transferKey(ledger.ticker, ledger.snapshotAt, entry.owner));
    }
  }
  return keys;
}

export function summarise(results: TransferResult[]) {
  const count = (outcome: TransferOutcome) =>
    results.filter((r) => r.outcome === outcome).length;
  return {
    sent: count("sent"),
    skipped: count("skipped"),
    failed: count("failed"),
    unknown: count("unknown"),
    total: results.length,
  };
}
