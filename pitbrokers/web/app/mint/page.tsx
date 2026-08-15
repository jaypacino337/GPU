"use client";

import { useCallback, useEffect, useState } from "react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import { useCollectionStats } from "@/lib/useCollectionStats";
import { buildMintNewIx } from "@/lib/instructions";
import { simulateThenSend, TransactionFailure } from "@/lib/sendTransaction";
import { StatTile } from "@/components/StatTile";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { formatTokens, groupDigits, explorerUrl, shortAddress } from "@/lib/format";
import { CLUSTER, TOKEN, SUPPLY_CAP } from "@config";

type Phase = "idle" | "submitting" | "revealing" | "done";

export default function MintPage() {
  const { connection } = useConnection();
  const { publicKey, signTransaction, connected } = useWallet();
  const { stats, refresh } = useCollectionStats();

  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [minted, setMinted] = useState<{ asset: string; signature: string } | null>(
    null,
  );

  const decimals = typeof TOKEN.decimals === "number" ? TOKEN.decimals : 0;
  const mintPrice = stats?.config.mintPrice ?? 0n;

  const loadBalance = useCallback(async () => {
    if (!publicKey || !stats) return;
    try {
      const ata = await getAssociatedTokenAddress(stats.config.tokenMint, publicKey);
      const account = await getAccount(connection, ata);
      setBalance(account.amount);
      setBalanceError(null);
    } catch {
      // No token account at all means a zero balance, not a failure.
      setBalance(0n);
      setBalanceError(null);
    }
  }, [connection, publicKey, stats]);

  useEffect(() => {
    void loadBalance();
  }, [loadBalance]);

  const soldOut = !!stats && stats.config.mintedCount >= stats.config.supplyCap;
  const paused = stats?.config.pausedMint ?? false;
  const canAfford = balance !== null && mintPrice > 0n && balance >= mintPrice;

  const blocker = !connected
    ? "Connect a wallet to mint."
    : !stats
      ? "Loading collection state…"
      : paused
        ? "Minting is paused."
        : soldOut
          ? "All 1000 have been minted."
          : stats.config.phase !== 2
            ? "Minting is not open yet."
            : !canAfford
              ? `You need ${formatTokens(mintPrice, decimals)} $${TOKEN.symbol} to mint.`
              : null;

  async function doMint() {
    if (!publicKey || !signTransaction || !stats) return;
    setConfirming(false);
    setPhase("submitting");
    setError(null);

    try {
      const asset = Keypair.generate();
      const buyerTokenAccount = await getAssociatedTokenAddress(
        stats.config.tokenMint,
        publicKey,
      );

      const ix = await buildMintNewIx({
        buyer: publicKey,
        asset: asset.publicKey,
        collection: stats.config.collection,
        tokenMint: stats.config.tokenMint,
        buyerTokenAccount,
        treasury: stats.config.treasury,
      });

      const signature = await simulateThenSend({
        connection,
        payer: publicKey,
        instructions: [ix],
        extraSigners: [asset],
        signTransaction,
      });

      setPhase("revealing");
      setMinted({ asset: asset.publicKey.toBase58(), signature });
      // Short beat so the reveal reads as a reveal rather than a flash.
      setTimeout(() => setPhase("done"), 900);
      void refresh();
      void loadBalance();
    } catch (e) {
      setPhase("idle");
      setError(
        e instanceof TransactionFailure ? e.message : e instanceof Error ? e.message : String(e),
      );
    }
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl text-bone">Mint</h1>
        <p className="mt-2 max-w-prose text-sm text-muted">
          One random unminted PitBroker per mint. You can sell it back to the
          program at any time for {groupDigits(950_000n)} ${TOKEN.symbol}.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Minted"
          tone="neon"
          value={
            stats ? `${stats.config.mintedCount} / ${stats.config.supplyCap}` : "—"
          }
        />
        <StatTile
          label="Price"
          value={stats ? formatTokens(stats.config.mintPrice, decimals) : "—"}
          hint={`$${TOKEN.symbol}`}
        />
        <StatTile
          label="Your balance"
          tone={canAfford ? "default" : "down"}
          value={balance === null ? "—" : formatTokens(balance, decimals)}
          hint={balanceError ?? `$${TOKEN.symbol}`}
        />
      </div>

      {stats && (
        <div className="panel p-4 text-xs text-muted">
          <p>
            Progress:{" "}
            <span className="text-neon">
              {Math.round((stats.config.mintedCount / SUPPLY_CAP) * 100)}%
            </span>
          </p>
          <div
            className="mt-2 h-3 w-full border-2 border-edge"
            role="progressbar"
            aria-valuenow={stats.config.mintedCount}
            aria-valuemin={0}
            aria-valuemax={SUPPLY_CAP}
          >
            <div
              className="h-full bg-neon"
              style={{
                width: `${(stats.config.mintedCount / SUPPLY_CAP) * 100}%`,
              }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="panel border-down p-4">
          <p className="font-display text-xs text-down">Mint failed</p>
          {/* The real reason, surfaced verbatim — never "transaction failed". */}
          <p className="mt-2 text-sm text-bone">{error}</p>
        </div>
      )}

      {phase === "revealing" && (
        <div className="panel-neon p-8 text-center">
          <p className="animate-pulse font-display text-sm text-neon">
            Revealing your broker…
          </p>
        </div>
      )}

      {phase === "done" && minted && (
        <div className="panel-neon p-5">
          <p className="font-display text-sm text-neon">You got a PitBroker</p>
          <dl className="mt-4 space-y-2 text-xs">
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Asset</dt>
              <dd>
                <a
                  className="text-neon underline"
                  href={explorerUrl("address", minted.asset, CLUSTER)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortAddress(minted.asset, 6, 6)}
                </a>
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Transaction</dt>
              <dd>
                <a
                  className="text-neon underline"
                  href={explorerUrl("tx", minted.signature, CLUSTER)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortAddress(minted.signature, 6, 6)}
                </a>
              </dd>
            </div>
          </dl>
          <a href="/my-brokers" className="btn-ghost mt-5 w-full">
            View in My Brokers
          </a>
        </div>
      )}

      <div>
        <button
          type="button"
          className="btn-primary w-full sm:w-auto"
          disabled={!!blocker || phase === "submitting"}
          onClick={() => setConfirming(true)}
        >
          {phase === "submitting" ? "Minting…" : "Mint one"}
        </button>
        {blocker && <p className="mt-3 text-xs text-muted">{blocker}</p>}
      </div>

      <ConfirmDialog
        open={confirming}
        title="Confirm mint"
        amountLine={`${formatTokens(mintPrice, decimals)} $${TOKEN.symbol}`}
        body={
          <>
            You will receive one random unminted PitBroker, plus roughly 0.003 SOL
            of account rent for the asset itself. You can sell it back to the
            program at any time for {groupDigits(950_000n)} ${TOKEN.symbol}.
          </>
        }
        confirmLabel="Mint"
        busy={phase === "submitting"}
        onConfirm={doMint}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
