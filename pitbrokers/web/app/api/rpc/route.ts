import { NextResponse } from "next/server";
import { serverRpcUrl } from "@config";
import { clientKey, rateLimit } from "@/lib/rateLimit";

/**
 * Server-side RPC proxy.
 *
 * The Helius key lives here and only here — the browser talks to this route, so
 * the key never reaches client code. Methods are allowlisted rather than
 * blocklisted: an open proxy in front of a keyed endpoint is somebody else's
 * free RPC, and we are on a free tier.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_METHODS = new Set([
  // Core reads the site needs
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getLatestBlockhash",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getTransaction",
  "getSlot",
  "getMinimumBalanceForRentExemption",
  "getProgramAccounts",
  // Simulation, so the UI can surface real errors before asking for a signature
  "simulateTransaction",
  "sendTransaction",
  // DAS — how we read holders without running an indexer
  "getAsset",
  "getAssetsByOwner",
  "getAssetsByGroup",
  "searchAssets",
]);

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 120;
const MAX_BODY_BYTES = 100_000;
const MAX_BATCH_SIZE = 10;

function rpcError(id: unknown, code: number, message: string, status: number) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });
}

export async function POST(request: Request) {
  const key = clientKey(request.headers);
  const limit = rateLimit(key, MAX_REQUESTS_PER_WINDOW, WINDOW_MS);
  if (!limit.ok) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32029, message: "Rate limit exceeded. Slow down." } },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((limit.resetAt - Date.now()) / 1000)),
          "X-RateLimit-Remaining": String(limit.remaining),
        },
      },
    );
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return rpcError(null, -32600, "Request body too large.", 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return rpcError(null, -32700, "Parse error.", 400);
  }

  // web3.js sends both single calls and batches.
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || calls.length > MAX_BATCH_SIZE) {
    return rpcError(null, -32600, `Batch size must be 1..${MAX_BATCH_SIZE}.`, 400);
  }

  for (const call of calls) {
    if (typeof call !== "object" || call === null) {
      return rpcError(null, -32600, "Invalid request.", 400);
    }
    const method = (call as { method?: unknown }).method;
    if (typeof method !== "string") {
      return rpcError((call as { id?: unknown }).id, -32600, "Missing method.", 400);
    }
    if (!ALLOWED_METHODS.has(method)) {
      return rpcError(
        (call as { id?: unknown }).id,
        -32601,
        `Method "${method}" is not permitted through this proxy.`,
        403,
      );
    }
  }

  let upstream: string;
  try {
    upstream = serverRpcUrl();
  } catch (e) {
    // Misconfiguration is ours, not the caller's — say so plainly in logs and
    // return something the UI can render without leaking the reason.
    console.error("[rpc] upstream not configured:", e);
    return rpcError(null, -32603, "RPC is not configured on the server.", 503);
  }

  try {
    const response = await fetch(upstream, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
      signal: AbortSignal.timeout(20_000),
    });

    const text = await response.text();
    return new NextResponse(text, {
      status: response.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-RateLimit-Remaining": String(limit.remaining),
      },
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    console.error("[rpc] upstream failure:", e);
    return rpcError(
      null,
      -32603,
      timedOut ? "RPC upstream timed out." : "RPC upstream is unreachable.",
      502,
    );
  }
}

export async function GET() {
  return NextResponse.json({ error: "POST only." }, { status: 405 });
}
