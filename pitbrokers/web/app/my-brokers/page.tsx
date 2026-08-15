"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { useCollectionStats } from "@/lib/useCollectionStats";
import { fetchOwnedBrokers } from "@/lib/das";
import { NftCard, NftCardSkeleton, type BrokerAsset } from "@/components/NftCard";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { buildRedeemIx } from "@/lib/instructions";
import { simulateThenSend, TransactionFailure } from "@/lib/sendTransaction";
import { formatTokens, explorerUrl, shortAddress } from "@/lib/format";
import { CLUSTER, TOKEN } from "@config";

export default function MyBrokersPage() {
  const { connection } = useConnection();
  const { publicKey, signTransaction, connected } = useWallet();
  const { stats, refresh } = useCollectionStats();

  const [assets, setAssets] = useState<BrokerAsset[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selling, setSelling] = useState<BrokerAsset | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSale, setLastSale] = useState<string | null>(null);

  const decimals = typeof TOKEN.decimals === "number" ? TOKEN.decimals : 0;
  const redeemPrice = stats?.config.redeemPrice ?? 0n;
  const collection = stats?.config.collection.toBase58();

  const load = useCallback(async () => {
    if (!publicKey || !collection) return;
    setLoadError(null);
    try {
      setAssets(await fetchOwnedBrokers(publicKey.toBase58(), collection));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [publicKey, collection]);

  useEffect(() => {
    void load();
  }, [load]);

  const canRedeem = (stats?.redemptionsAvailable ?? 0) > 0;
  const redeemPaused = stats?.config.pausedRedeem ?? false;

  async function doRedeem() {
    if (!publicKey || !signTransaction || !stats || !selling) return;
    setBusy(true);
    setError(null);
    try {
      const holderTokenAccount = await getAssociatedTokenAddress(
        stats.config.tokenMint,
        publicKey,
      );
      const ix = await buildRedeemIx({
        holder: publicKey,
        asset: new (await import("@solana/web3.js")).PublicKey(selling.address),
        collection: stats.config.collection,
        tokenMint: stats.config.tokenMint,
        holderTokenAccount,
        treasury: stats.config.treasury,
      });

      const signature = await simulateThenSend({
        connection,
        payer: publicKey,
        instructions: [ix],
        signTransaction,
      });

      setLastSale(signature);
      setSelling(null);
      void refresh();
      void load();
    } catch (e) {
      setError(
        e instanceof TransactionFailure
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(false);
    }
  }

  if (!connected) {
    return (
      <EmptyState
        title="My Brokers"
        message="Connect a wallet to see the PitBrokers you hold."
      />
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl text-bone">My Brokers</h1>
          <p className="mt-2 text-sm text-muted">
            Sell any broker back to the program for{" "}
            <span className="text-neon">
              {formatTokens(redeemPrice, decimals)} ${TOKEN.symbol}
            </span>
            .
          </p>
        </div>
        <p className="text-xs text-muted">
          Redemptions available right now:{" "}
          <span className={canRedeem ? "text-neon" : "text-down"}>
            {stats?.redemptionsAvailable ?? "—"}
          </span>
        </p>
      </header>

      {redeemPaused && (
        <Banner tone="down">Sell-back is currently paused by the program authority.</Banner>
      )}
      {!redeemPaused && !canRedeem && stats && (
        <Banner tone="down">
          The treasury cannot cover a sell-back right now. Selling back will fail
          until it is topped up — this is shown up front rather than as a failed
          transaction.
        </Banner>
      )}
      {lastSale && (
        <Banner tone="neon">
          Sold back.{" "}
          <a
            className="underline"
            href={explorerUrl("tx", lastSale, CLUSTER)}
            target="_blank"
            rel="noreferrer"
          >
            {shortAddress(lastSale, 6, 6)}
          </a>
        </Banner>
      )}
      {error && <Banner tone="down">{error}</Banner>}
      {loadError && <Banner tone="down">Could not load your brokers: {loadError}</Banner>}

      {assets === null ? (
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <NftCardSkeleton key={i} />
          ))}
        </div>
      ) : assets.length === 0 ? (
        <EmptyState
          title="Nothing here yet"
          message="You do not hold any PitBrokers."
          cta={{ href: "/mint", label: "Mint one" }}
        />
      ) : (
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          {assets.map((asset) => (
            <NftCard
              key={asset.address}
              asset={asset}
              footer={
                <button
                  type="button"
                  className="btn-danger w-full text-[10px]"
                  disabled={redeemPaused || !canRedeem}
                  onClick={() => {
                    setError(null);
                    setSelling(asset);
                  }}
                >
                  Sell back for {formatTokens(redeemPrice, decimals)}
                </button>
              }
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!selling}
        danger
        title={`Sell back ${selling?.name ?? ""}`}
        amountLine={`You receive ${formatTokens(redeemPrice, decimals)} $${TOKEN.symbol}`}
        body={
          <>
            {selling?.name} goes back to the program and returns to the mintable
            pool. You will no longer own it, and it may be minted by someone else.
          </>
        }
        confirmLabel="Sell back"
        busy={busy}
        onConfirm={doRedeem}
        onCancel={() => setSelling(null)}
      />
    </div>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "neon" | "down";
  children: React.ReactNode;
}) {
  const cls = tone === "neon" ? "border-neon text-neon" : "border-down text-bone";
  return <div className={`panel ${cls} p-3 text-sm`}>{children}</div>;
}

function EmptyState({
  title,
  message,
  cta,
}: {
  title: string;
  message: string;
  cta?: { href: string; label: string };
}) {
  return (
    <div className="panel p-8 text-center">
      <h1 className="font-display text-sm text-bone">{title}</h1>
      <p className="mt-3 text-sm text-muted">{message}</p>
      {cta && (
        <a href={cta.href} className="btn-primary mt-6 inline-flex">
          {cta.label}
        </a>
      )}
    </div>
  );
}
