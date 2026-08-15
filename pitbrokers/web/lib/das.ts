import { CLIENT_RPC_PATH } from "@config";
import type { BrokerAsset } from "@/components/NftCard";

/**
 * DAS reads, via our own RPC proxy.
 *
 * This is what lets us skip a database entirely — holders and wallet contents
 * come from `getAssetsByGroup` / `getAssetsByOwner` rather than an index we
 * maintain. Everything goes through the proxy so the Helius key stays server-side.
 */

interface DasAsset {
  id: string;
  ownership?: { owner?: string };
  content?: {
    metadata?: {
      name?: string;
      attributes?: Array<{ trait_type: string; value: string }>;
    };
    files?: Array<{ uri?: string; cdn_uri?: string }>;
    links?: { image?: string };
    json_uri?: string;
  };
  grouping?: Array<{ group_key: string; group_value: string }>;
}

async function das<T>(method: string, params: unknown): Promise<T> {
  const response = await fetch(CLIENT_RPC_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error("Too many requests — wait a moment and try again.");
    }
    throw new Error(`RPC ${method} failed with HTTP ${response.status}`);
  }

  const json = (await response.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? `RPC ${method} failed`);
  if (json.result === undefined) throw new Error(`RPC ${method} returned no result`);
  return json.result;
}

function toBroker(asset: DasAsset): BrokerAsset {
  const meta = asset.content?.metadata;
  const attributes = meta?.attributes ?? [];
  const airdrop = attributes.find(
    (a) => a.trait_type?.toLowerCase() === "airdrop",
  )?.value;

  const image =
    asset.content?.links?.image ??
    asset.content?.files?.[0]?.cdn_uri ??
    asset.content?.files?.[0]?.uri;

  const name = meta?.name ?? "PitBroker";
  const indexMatch = name.match(/#(\d+)/);

  return {
    address: asset.id,
    name,
    image,
    index: indexMatch ? Number(indexMatch[1]) : undefined,
    airdropTicker: airdrop,
    attributes,
  };
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
}

/** Assets in our collection, paginated — the gallery never loads 1,000 at once. */
export async function fetchCollectionPage(
  collection: string,
  page: number,
  limit = 24,
): Promise<Page<BrokerAsset>> {
  const result = await das<{ items: DasAsset[]; total: number }>(
    "getAssetsByGroup",
    { groupKey: "collection", groupValue: collection, page, limit },
  );
  return {
    items: result.items.map(toBroker),
    total: result.total,
    page,
  };
}

/** A wallet's PitBrokers, filtered to our collection. */
export async function fetchOwnedBrokers(
  owner: string,
  collection: string,
): Promise<BrokerAsset[]> {
  const result = await das<{ items: DasAsset[] }>("getAssetsByOwner", {
    ownerAddress: owner,
    page: 1,
    limit: 1000,
  });

  return result.items
    .filter((a) =>
      a.grouping?.some(
        (g) => g.group_key === "collection" && g.group_value === collection,
      ),
    )
    .map(toBroker);
}

/**
 * Every holder of a ticker piece, read live from chain at call time.
 *
 * The airdrop snapshot uses this rather than a cached list — a stale holder list
 * would send tokens to people who already sold.
 */
export async function snapshotHolders(
  collection: string,
): Promise<Map<string, BrokerAsset[]>> {
  const byOwner = new Map<string, BrokerAsset[]>();
  let page = 1;

  for (;;) {
    const result = await das<{ items: DasAsset[]; total: number }>(
      "getAssetsByGroup",
      { groupKey: "collection", groupValue: collection, page, limit: 1000 },
    );
    if (result.items.length === 0) break;

    for (const raw of result.items) {
      const owner = raw.ownership?.owner;
      if (!owner) continue;
      const broker = toBroker(raw);
      if (!broker.airdropTicker) continue;
      const existing = byOwner.get(owner);
      if (existing) existing.push(broker);
      else byOwner.set(owner, [broker]);
    }

    if (result.items.length < 1000) break;
    page += 1;
    // Hard stop — 1,000 assets means at most one full page, so more than a
    // couple of iterations indicates the RPC is looping.
    if (page > 5) break;
  }

  return byOwner;
}

/** Vault-held (recycled) assets — the pool `mint_recycled` draws from. */
export async function fetchVaultAssets(
  vault: string,
  collection: string,
): Promise<BrokerAsset[]> {
  return fetchOwnedBrokers(vault, collection);
}
