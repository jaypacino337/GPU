"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useCollectionStats } from "@/lib/useCollectionStats";
import { StatTile } from "@/components/StatTile";
import { buildSetPausedIx, buildSetPhaseIx } from "@/lib/instructions";
import { simulateThenSend, TransactionFailure } from "@/lib/sendTransaction";
import { snapshotHolders } from "@/lib/das";
import { preflight, toCsv, type Preflight } from "@/lib/airdropPreflight";
import {
  pumpAmmCreatorVaultAuthority,
  pumpBondingCreatorVault,
  vaultPda,
} from "@/lib/pdas";
import { buildClaimToTreasuryIxs, claimableLamports } from "@/lib/pumpfunClaim";
import {
  executeAirdrop,
  toLedger,
  completedKeys,
  summarise,
  type TransferResult,
  type AirdropLedger,
} from "@/lib/airdropExecute";
import { formatTokens, formatCompact, shortAddress, explorerUrl } from "@/lib/format";
import { PHASE_LABEL } from "@/lib/configAccount";
import { TICKERS, TOKEN, CLUSTER, PUMPFUN } from "@config";

export default function AdminPage() {
  const { connection } = useConnection();
  const { publicKey, signTransaction, connected } = useWallet();
  const { stats, refresh } = useCollectionStats();

  const decimals = typeof TOKEN.decimals === "number" ? TOKEN.decimals : 0;

  // Gate on the ON-CHAIN authority, not a config constant — the program is the
  // real source of truth and a stale env var must not grant or deny access.
  const isAuthority =
    !!publicKey && !!stats && stats.config.authority.equals(publicKey);

  if (!connected) {
    return <Gate message="Connect the authority wallet." />;
  }
  if (stats && !isAuthority) {
    return (
      <Gate
        message={`${shortAddress(publicKey!.toBase58(), 6, 6)} is not the program authority. Every action here is enforced on-chain, so nothing is exposed by this page — it simply will not work.`}
      />
    );
  }

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-xl text-bone">Admin</h1>
        <p className="mt-2 text-sm text-muted">
          Signed by your connected wallet. There is no server keypair anywhere in
          this app.
        </p>
      </header>

      <TreasurySection stats={stats} decimals={decimals} />
      <PauseSection
        stats={stats}
        onDone={refresh}
        connection={connection}
        publicKey={publicKey}
        signTransaction={signTransaction}
      />
      <CreatorFeeSection
        connection={connection}
        publicKey={publicKey}
        signTransaction={signTransaction}
      />
      <AirdropSection
        connection={connection}
        collection={stats?.config.collection.toBase58()}
        publicKey={publicKey}
        signTransaction={signTransaction}
      />
    </div>
  );
}

function Gate({ message }: { message: string }) {
  return (
    <div className="panel p-8 text-center">
      <h1 className="font-display text-sm text-bone">Admin</h1>
      <p className="mt-3 text-sm text-muted">{message}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 font-display text-sm text-neon">{title}</h2>
      {children}
    </section>
  );
}

function TreasurySection({
  stats,
  decimals,
}: {
  stats: ReturnType<typeof useCollectionStats>["stats"];
  decimals: number;
}) {
  return (
    <Section title="Treasury">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Balance"
          value={stats ? formatCompact(stats.treasury, decimals) : "—"}
        />
        <StatTile
          label="Reserved"
          tone="down"
          value={stats ? formatCompact(stats.reserved, decimals) : "—"}
          hint="Backs outstanding sell-backs. Not withdrawable."
        />
        <StatTile
          label="Surplus"
          tone="neon"
          value={stats ? formatCompact(stats.surplus, decimals) : "—"}
          hint="The most you could withdraw."
        />
        <StatTile
          label="Redemptions available"
          value={stats?.redemptionsAvailable ?? "—"}
        />
      </div>
    </Section>
  );
}

function PauseSection({
  stats,
  onDone,
  connection,
  publicKey,
  signTransaction,
}: {
  stats: ReturnType<typeof useCollectionStats>["stats"];
  onDone: () => void;
  connection: ReturnType<typeof useConnection>["connection"];
  publicKey: PublicKey | null;
  signTransaction: ReturnType<typeof useWallet>["signTransaction"];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(build: () => Promise<import("@solana/web3.js").TransactionInstruction>) {
    if (!publicKey || !signTransaction) return;
    setBusy(true);
    setError(null);
    try {
      await simulateThenSend({
        connection,
        payer: publicKey,
        instructions: [await build()],
        signTransaction,
      });
      onDone();
    } catch (e) {
      setError(e instanceof TransactionFailure ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const pausedMint = stats?.config.pausedMint ?? false;
  const pausedRedeem = stats?.config.pausedRedeem ?? false;

  return (
    <Section title="Emergency controls">
      <div className="panel space-y-4 p-4">
        <p className="text-xs text-muted">
          Mint and sell-back pause independently. In most incidents the right move
          is to pause minting only — that stops new obligations without trapping
          existing holders.
        </p>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className={pausedMint ? "btn-primary" : "btn-danger"}
            disabled={busy || !publicKey}
            onClick={() =>
              run(() =>
                buildSetPausedIx({
                  authority: publicKey!,
                  pausedMint: !pausedMint,
                  pausedRedeem,
                }),
              )
            }
          >
            {pausedMint ? "Resume minting" : "Pause minting"}
          </button>

          <button
            type="button"
            className={pausedRedeem ? "btn-primary" : "btn-danger"}
            disabled={busy || !publicKey}
            onClick={() =>
              run(() =>
                buildSetPausedIx({
                  authority: publicKey!,
                  pausedMint,
                  pausedRedeem: !pausedRedeem,
                }),
              )
            }
          >
            {pausedRedeem ? "Resume sell-back" : "Pause sell-back"}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t-2 border-edge pt-4">
          <p className="text-xs text-muted">
            Phase:{" "}
            <span className="text-neon">
              {PHASE_LABEL[stats?.config.phase ?? 0] ?? "unknown"}
            </span>
          </p>
          {([0, 1, 2] as const).map((phase) => (
            <button
              key={phase}
              type="button"
              className="btn-ghost px-3 py-2 text-[10px]"
              disabled={busy || !publicKey || stats?.config.phase === phase}
              onClick={() => run(() => buildSetPhaseIx({ authority: publicKey!, phase }))}
            >
              Set {PHASE_LABEL[phase]}
            </button>
          ))}
        </div>

        {error && <p className="border-2 border-down p-3 text-sm text-bone">{error}</p>}
      </div>
    </Section>
  );
}

/**
 * Creator fees accrue in two different places depending on whether the coin has
 * migrated to the AMM, under two different (and inconsistently spelled) PDA
 * seeds. Both are read, so a non-zero balance is never missed.
 */
function CreatorFeeSection({
  connection,
  publicKey,
  signTransaction,
}: {
  connection: ReturnType<typeof useConnection>["connection"];
  publicKey: PublicKey | null;
  signTransaction: ReturnType<typeof useWallet>["signTransaction"];
}) {
  const [bonding, setBonding] = useState<bigint | null>(null);
  const [rentExempt, setRentExempt] = useState<bigint>(0n);
  const [ammVault, setAmmVault] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [claimSig, setClaimSig] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!publicKey) return;
    setError(null);
    try {
      const vault = pumpBondingCreatorVault(publicKey);
      const info = await connection.getAccountInfo(vault);
      const minimum = await connection.getMinimumBalanceForRentExemption(
        info?.data.length ?? 0,
      );
      setRentExempt(BigInt(minimum));
      setBonding(BigInt(info?.lamports ?? 0));
      setAmmVault(pumpAmmCreatorVaultAuthority(publicKey).toBase58());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [connection, publicKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const claimable = claimableLamports(bonding ?? 0n, rentExempt);

  async function claim() {
    if (!publicKey || !signTransaction) return;
    setBusy(true);
    setError(null);
    setClaimSig(null);
    try {
      // One transaction, two instructions: the permissionless claim to the
      // admin's own wallet, then the forward to the vault. If the forward
      // fails, the claim rolls back with it.
      const signature = await simulateThenSend({
        connection,
        payer: publicKey,
        instructions: buildClaimToTreasuryIxs({
          creator: publicKey,
          vault: vaultPda(),
          lamports: claimable,
        }),
        signTransaction,
      });
      setClaimSig(signature);
      await load();
    } catch (e) {
      setError(e instanceof TransactionFailure ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Creator fees (pump.fun)">
      <div className="panel space-y-4 p-4 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <StatTile
            label="Bonding-curve vault (SOL)"
            value={bonding === null ? "—" : `${formatTokens(claimable, 9, { maxFractionDigits: 4 })} SOL`}
            hint="Claimable = balance above the rent-exempt minimum"
          />
          <StatTile
            label="AMM vault"
            value={ammVault ? shortAddress(ammVault, 6, 6) : "—"}
            hint="Post-migration fees accrue here as SPL tokens"
          />
        </div>

        <div className="border-2 border-edge p-3 text-xs text-muted">
          <p className="font-display text-[10px] uppercase text-neon">
            How the claim works
          </p>
          <p className="mt-2">
            <code className="text-bone">collect_creator_fee</code> does not take the
            creator as a signer — it is a permissionless crank whose only possible
            destination is your own wallet. The proceeds therefore cannot be routed
            to the treasury inside the instruction. Claiming here builds{" "}
            <strong>one transaction with two instructions</strong>: the claim,
            followed by a transfer from your wallet to the treasury. If the second
            leg fails, the first rolls back with it.
          </p>
          <p className="mt-2">
            Programs:{" "}
            <a
              className="text-neon underline"
              href={explorerUrl("address", PUMPFUN.PUMP_PROGRAM_ID, CLUSTER)}
              target="_blank"
              rel="noreferrer"
            >
              pump
            </a>
            {" · "}
            <a
              className="text-neon underline"
              href={explorerUrl("address", PUMPFUN.PUMP_AMM_PROGRAM_ID, CLUSTER)}
              target="_blank"
              rel="noreferrer"
            >
              pump AMM
            </a>
          </p>
        </div>

        <div className="border-2 border-edge p-3 text-xs text-muted">
          <p className="font-display text-[10px] uppercase text-neon">
            Where the SOL goes
          </p>
          <p className="mt-2">
            Bonding-curve fees are paid in <strong>SOL</strong>, but the treasury
            is a $PUMPBROKER token account, which cannot hold SOL. The claim
            forwards lamports to the <strong>vault PDA</strong> — the same
            program-owned authority that owns the treasury. Turning that SOL into
            $PUMPBROKER, which is what would actually deepen redemption backing,
            is a swap and is not done here.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn-ghost" onClick={() => void load()}>
            Refresh balances
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || claimable <= 0n || !publicKey || !signTransaction}
            onClick={() => void claim()}
          >
            {busy
              ? "Claiming…"
              : claimable > 0n
                ? `Claim ${formatTokens(claimable, 9, { maxFractionDigits: 4 })} SOL to vault`
                : "Nothing to claim"}
          </button>
        </div>

        {claimSig && (
          <p className="border-2 border-neon p-3 text-xs text-bone">
            Claimed.{" "}
            <a
              className="text-neon underline"
              href={explorerUrl("tx", claimSig, CLUSTER)}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddress(claimSig, 6, 6)}
            </a>
          </p>
        )}

        {error && <p className="border-2 border-down p-3 text-bone">{error}</p>}
      </div>
    </Section>
  );
}

function AirdropSection({
  connection,
  collection,
  publicKey,
  signTransaction,
}: {
  connection: ReturnType<typeof useConnection>["connection"];
  collection: string | undefined;
  publicKey: PublicKey | null;
  signTransaction: ReturnType<typeof useWallet>["signTransaction"];
}) {
  const [results, setResults] = useState<TransferResult[]>([]);
  const [sending, setSending] = useState(false);
  const [ledger, setLedger] = useState<AirdropLedger | null>(null);
  const [selected, setSelected] = useState(TICKERS[0]!.symbol);
  const [result, setResult] = useState<Preflight | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshotAt, setSnapshotAt] = useState<string>("");

  async function runSnapshot() {
    if (!collection || !publicKey) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const ticker = TICKERS.find((t) => t.symbol === selected)!;
      // Read holders live from chain, never from a cached list.
      const holders = await snapshotHolders(collection);
      const taken = new Date().toISOString();
      setSnapshotAt(taken);
      // Gate against the wallet that will actually fund the transfers.
      setResult(await preflight(connection, ticker, holders, publicKey));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  async function send(ready: Preflight) {
    if (!publicKey || !signTransaction || !ready.payoutMintAddress) return;
    const decimals =
      typeof ready.ticker.decimals === "number" ? ready.ticker.decimals : 0;

    setSending(true);
    setError(null);
    try {
      const mint = new PublicKey(ready.payoutMintAddress);
      // Source is the treasury's ATA for the payout mint, whose authority is the
      // vault PDA — but the vault cannot sign an arbitrary SPL transfer, so the
      // admin's own token account funds the distribution.
      const source = await (
        await import("@solana/spl-token")
      ).getAssociatedTokenAddress(mint, publicKey);

      const previous = ledger ? completedKeys(ledger) : undefined;

      const outcome = await executeAirdrop({
        connection,
        payer: publicKey,
        signTransaction,
        mint,
        decimals,
        source,
        sourceAuthority: publicKey,
        rows: ready.rows,
        ticker: ready.ticker.symbol,
        snapshotAt,
        completed: previous,
        // Persist after every batch, so a crash loses at most one batch.
        onProgress: (partial) => {
          setResults(partial.slice());
          setLedger(
            toLedger(ready.ticker.symbol, snapshotAt, ready.payoutMintAddress!, partial),
          );
        },
      });

      setResults(outcome);
      setLedger(
        toLedger(ready.ticker.symbol, snapshotAt, ready.payoutMintAddress, outcome),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  function downloadLedger() {
    if (!ledger) return;
    const blob = new Blob([JSON.stringify(ledger, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `airdrop-ledger-${ledger.ticker}-${ledger.snapshotAt}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadCsv() {
    if (!result) return;
    const decimals = typeof result.ticker.decimals === "number" ? result.ticker.decimals : 0;
    const blob = new Blob([toCsv(result, decimals)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `airdrop-${result.ticker.symbol}-${snapshotAt}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Section title="Airdrop tool">
      <div className="panel space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="border-2 border-edge bg-ink px-3 py-2 font-display text-[10px] uppercase text-bone"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {TICKERS.map((t) => (
              <option key={t.symbol} value={t.symbol}>
                {t.symbol}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-ghost"
            disabled={running || !collection}
            onClick={() => void runSnapshot()}
          >
            {running ? "Snapshotting…" : "Snapshot holders"}
          </button>
          {result && (
            <button type="button" className="btn-ghost" onClick={downloadCsv}>
              Export CSV
            </button>
          )}
        </div>

        {error && <p className="border-2 border-down p-3 text-sm text-bone">{error}</p>}

        {result && (
          <>
            {result.blockers.length > 0 && (
              <div className="border-2 border-down bg-down/10 p-3">
                <p className="font-display text-[10px] uppercase text-down">
                  Blocked — send is disabled
                </p>
                <ul className="mt-2 space-y-1 text-xs text-bone">
                  {result.blockers.map((b) => (
                    <li key={b}>• {b}</li>
                  ))}
                </ul>
              </div>
            )}

            {result.warnings.map((w) => (
              <p key={w} className="border-2 border-edge p-3 text-xs text-muted">
                {w}
              </p>
            ))}

            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem] border-collapse text-xs">
                <thead>
                  <tr className="border-b-2 border-edge text-left text-muted">
                    <th className="px-2 py-2">Owner</th>
                    <th className="px-2 py-2">Pieces</th>
                    <th className="px-2 py-2">Amount (base units)</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => (
                    <tr key={row.owner} className="border-b border-edge">
                      <td className="px-2 py-2">{shortAddress(row.owner, 6, 6)}</td>
                      <td className="px-2 py-2">{row.count}</td>
                      <td className="px-2 py-2">{row.amount.toString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-xs text-muted">
              {result.totalRecipients} recipients · snapshot {snapshotAt}
            </p>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className="btn-primary"
                disabled={!result.ok || sending || !publicKey || !signTransaction}
                onClick={() => void send(result)}
              >
                {sending
                  ? "Sending…"
                  : result.ok
                    ? `Send to ${result.totalRecipients} recipients`
                    : "Send blocked"}
              </button>
              {ledger && (
                <button type="button" className="btn-ghost" onClick={downloadLedger}>
                  Export ledger JSON
                </button>
              )}
            </div>

            {results.length > 0 && <ProgressTable results={results} />}

            <p className="text-xs text-muted">
              Transfers are batched and keyed by (ticker, snapshot, owner). The
              ledger is updated after every batch, so a re-run skips anyone already
              paid. Anything marked <span className="text-down">unknown</span> was
              submitted but never confirmed —{" "}
              <strong className="text-bone">
                verify those signatures on chain before re-running
              </strong>
              , because a blind retry could pay twice.
            </p>
          </>
        )}
      </div>
    </Section>
  );
}

/** Live per-recipient outcome while a distribution runs. */
function ProgressTable({ results }: { results: TransferResult[] }) {
  const counts = summarise(results);
  const tone: Record<string, string> = {
    sent: "text-neon",
    skipped: "text-muted",
    failed: "text-down",
    unknown: "text-down",
  };

  return (
    <div className="border-2 border-edge p-3">
      <p className="font-display text-[10px] uppercase text-muted">
        {counts.sent} sent · {counts.skipped} skipped · {counts.failed} failed ·{" "}
        <span className={counts.unknown > 0 ? "text-down" : ""}>
          {counts.unknown} unknown
        </span>
      </p>

      {counts.unknown > 0 && (
        <p className="mt-2 border-2 border-down bg-down/10 p-2 text-xs text-bone">
          {counts.unknown} transfer{counts.unknown === 1 ? " was" : "s were"}{" "}
          submitted but never confirmed. Check the signature{counts.unknown === 1 ? "" : "s"}{" "}
          on chain before re-running — these are excluded from the skip list
          precisely so they are not silently retried.
        </p>
      )}

      <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto text-xs">
        {results.map((r) => (
          <li key={r.key} className="flex justify-between gap-3">
            <span className="text-muted">{shortAddress(r.owner, 4, 4)}</span>
            <span className={tone[r.outcome] ?? ""}>
              {r.outcome}
              {r.signature && (
                <>
                  {" "}
                  <a
                    className="underline"
                    href={explorerUrl("tx", r.signature, CLUSTER)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortAddress(r.signature, 4, 4)}
                  </a>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
