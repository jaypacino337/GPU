"use client";

import { airdropReadiness, PayoutAsset, CLUSTER } from "@config";
import { explorerUrl, shortAddress } from "@/lib/format";

/**
 * Public airdrop page: which tickers are live, and the permanent record of past
 * distributions.
 *
 * The record is intentionally read from a committed JSON file of on-chain
 * signatures rather than a database — it is a public, permanent claim, so it
 * should be verifiable against chain by anyone reading it.
 */

interface DistributionRecord {
  ticker: string;
  snapshotAt: string;
  recipients: number;
  transfers: Array<{ owner: string; amount: string; signature: string }>;
}

// Populated by the admin airdrop tool. Empty until the first distribution runs.
const RECORDS: DistributionRecord[] = [];

export default function AirdropPage() {
  const readiness = airdropReadiness();
  const live = readiness.filter((r) => r.configured);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl text-bone">Airdrop</h1>
        <p className="mt-2 max-w-prose text-sm text-muted">
          100 of the 1,000 PumpBrokers — 10 per ticker — carry an{" "}
          <code className="text-neon">Airdrop</code> attribute naming a tokenized
          stock. Holders of those pieces receive a distribution of the matching
          asset.
        </p>
      </header>

      <section className="panel border-neon p-4">
        <h2 className="font-display text-xs text-neon">What this is and is not</h2>
        <ul className="mt-3 space-y-2 text-sm text-muted">
          <li>
            • The snapshot is taken from chain at a published time. Whoever holds
            the piece at that moment receives the distribution.
          </li>
          <li>
            • It does not follow the NFT on resale. Selling after the snapshot does
            not transfer the claim.
          </li>
          <li>
            • A ticker only goes live once its mint address is verified. Unverified
            tickers cannot be distributed — the tool refuses to run for them.
          </li>
          <li>
            • Every transfer signature is published below, permanently.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="mb-3 text-sm text-muted">
          Tickers — {live.length} of {readiness.length} live
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-sm">
            <thead>
              <tr className="border-b-2 border-edge text-left">
                <Th>Ticker</Th>
                <Th>Name</Th>
                <Th>Pays</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {readiness.map(({ ticker, configured, blockers }) => (
                <tr key={ticker.symbol} className="border-b border-edge">
                  <Td>
                    <span className="font-display text-xs text-bone">
                      {ticker.symbol}
                    </span>
                  </Td>
                  <Td className="text-muted">{ticker.name}</Td>
                  <Td className="text-muted">
                    {ticker.payout === PayoutAsset.Usdc ? "USDC equivalent" : "xStock"}
                  </Td>
                  <Td>
                    {configured ? (
                      <span className="tag border-neon text-neon">Live</span>
                    ) : (
                      <span
                        className="tag border-muted text-muted"
                        title={blockers.join("; ")}
                      >
                        Pending mint address
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm text-muted">Distribution record</h2>
        {RECORDS.length === 0 ? (
          <p className="panel p-6 text-center text-sm text-muted">
            No distributions have run yet. Every transfer will be listed here with
            its transaction signature once one does.
          </p>
        ) : (
          <div className="space-y-6">
            {RECORDS.map((record) => (
              <div key={`${record.ticker}-${record.snapshotAt}`} className="panel p-4">
                <h3 className="font-display text-xs text-neon">
                  {record.ticker} — {record.recipients} recipients
                </h3>
                <p className="mt-1 text-xs text-muted">
                  Snapshot {new Date(record.snapshotAt).toUTCString()}
                </p>
                <ul className="mt-3 space-y-1 text-xs">
                  {record.transfers.map((t) => (
                    <li key={t.signature} className="flex justify-between gap-4">
                      <span className="text-muted">{shortAddress(t.owner, 6, 6)}</span>
                      <a
                        className="text-neon underline"
                        href={explorerUrl("tx", t.signature, CLUSTER)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {shortAddress(t.signature, 6, 6)}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-2 py-2 font-display text-[10px] uppercase tracking-wider text-muted">
      {children}
    </th>
  );
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-2 py-3 ${className}`}>{children}</td>;
}
