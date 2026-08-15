"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { configProblems, redemptionsAvailable } from "@config";
import { configPda } from "./pdas";
import { decodeConfig, type ConfigAccount } from "./configAccount";

export interface CollectionStats {
  config: ConfigAccount;
  /** Treasury balance in base units. */
  treasury: bigint;
  /** floor(treasury / redeem_price) — what the site advertises. */
  redemptionsAvailable: number;
  /** Locked to back outstanding sell-backs; not withdrawable. */
  reserved: bigint;
  surplus: bigint;
}

export function useCollectionStats(pollMs = 15_000) {
  const { connection } = useConnection();
  const [stats, setStats] = useState<CollectionStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (configProblems().length > 0) {
      setError("Site is not configured yet.");
      setLoading(false);
      return;
    }
    try {
      const pda = configPda();
      const info = await connection.getAccountInfo(pda);
      if (!info) {
        throw new Error(
          "Program config account not found — the program may not be initialized on this cluster.",
        );
      }
      const config = decodeConfig(new Uint8Array(info.data));

      const balance = await connection.getTokenAccountBalance(config.treasury);
      const treasury = BigInt(balance.value.amount);

      const reserved = BigInt(config.circulating) * config.redeemPrice;
      setStats({
        config,
        treasury,
        redemptionsAvailable: redemptionsAvailable(treasury),
        reserved,
        surplus: treasury > reserved ? treasury - reserved : 0n,
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (!cancelled) await refresh();
    };
    void tick();
    const id = setInterval(tick, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refresh, pollMs]);

  return { stats, error, loading, refresh };
}
