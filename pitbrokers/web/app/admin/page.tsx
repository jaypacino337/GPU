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
import { pumpAmmCreatorVaultAuthority, pumpBondingCreatorVault } from "@/lib/pdas";
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
      <CreatorFeeSection connection={connection} publicKey={publicKey} />
      <AirdropSection
        connection={connection}
        collection={stats?.config.collection.toBase58()}
        vault={stats?.config.treasury}
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
}: {
  connection: ReturnType<typeof useConnection>["connection"];
  publicKey: PublicKey | null;
}) {
  const [bonding, setBonding] = useState<bigint | null>(null);
  const [rentExempt, setRentExempt] = useState<bigint>(0n);
  const [ammVault, setAmmVault] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const claimable = bonding !== null && bonding > rentExempt ? bonding - rentExempt : 0n;

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

        <button type="button" className="btn-ghost" onClick={() => void load()}>
          Refresh balances
        </button>

        {error && <p className="border-2 border-down p-3 text-bone">{error}</p>}

        <p className="text-xs text-muted">
          Claim execution is wired to the verified IDL discriminators in{" "}
          <code>config/pumpfun.ts</code>; it stays disabled until the flow has been
          exercised on devnet against a real creator vault.
        </p>
      </div>
    </Section>
  );
}

function AirdropSection({
  connection,
  collection,
  vault,
}: {
  connection: ReturnType<typeof useConnection>["connection"];
  collection: string | undefined;
  vault: PublicKey | undefined;
}) {
  const [selected, setSelected] = useState(TICKERS[0]!.symbol);
  const [result, setResult] = useState<Preflight | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshotAt, setSnapshotAt] = useState<string>("");

  async function runSnapshot() {
    if (!collection || !vault) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const ticker = TICKERS.find((t) => t.symbol === selected)!;
      // Read holders live from chain, never from a cached list.
      const holders = await snapshotHolders(collection);
      const taken = new Date().toISOString();
      setSnapshotAt(taken);
      setResult(await preflight(connection, ticker, holders, vault));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
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

            <button type="button" className="btn-primary" disabled={!result.ok}>
              {result.ok ? "Send distribution" : "Send blocked"}
            </button>
            <p className="text-xs text-muted">
              Execution runs batched transfers keyed by (ticker, snapshot, owner) so
              a partial failure can be safely re-run without double-paying. It stays
              disabled until a ticker passes every gate.
            </p>
          </>
        )}
      </div>
    </Section>
  );
}
