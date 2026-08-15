"use client";

import { configProblems, CLUSTER } from "@config";

/**
 * Loud banner when the app is running with placeholder config, and a quieter one
 * on devnet.
 *
 * The failure this prevents is subtle: a half-configured deploy that looks fine
 * until someone signs a transaction against the wrong mint. Better to be
 * impossible to miss.
 */
export function ConfigBanner() {
  const problems = configProblems();

  if (problems.length > 0) {
    return (
      <div className="border-b-2 border-down bg-down/15 px-4 py-3">
        <div className="mx-auto max-w-6xl text-xs">
          <p className="font-display text-down">⚠ NOT CONFIGURED — DO NOT USE</p>
          <ul className="mt-2 space-y-1 text-bone">
            {problems.map((p) => (
              <li key={p.key}>
                <code className="text-neon">{p.key}</code> — {p.detail}
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (CLUSTER !== "mainnet-beta") {
    return (
      <div className="border-b-2 border-neon bg-neon/10 px-4 py-2">
        <p className="mx-auto max-w-6xl font-display text-[10px] uppercase text-neon">
          Devnet — tokens and NFTs here are worthless test assets
        </p>
      </div>
    );
  }

  return null;
}
