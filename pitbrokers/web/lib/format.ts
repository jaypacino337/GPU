/**
 * Amount formatting. No floats, anywhere, ever.
 *
 * Every token amount in this app is a `bigint` of base units. Nothing here
 * converts through `Number` on a value that could exceed 2^53 — 1,000,000
 * $PUMPBROKER at 9 decimals is 10^15 base units, comfortably past the point
 * where `Number` silently loses precision.
 */

/**
 * Split base units into whole and fractional parts using integer division only.
 */
function split(baseUnits: bigint, decimals: number): { whole: bigint; frac: bigint } {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new Error(`invalid decimals: ${decimals}`);
  }
  const scale = 10n ** BigInt(decimals);
  const negative = baseUnits < 0n;
  const abs = negative ? -baseUnits : baseUnits;
  const whole = abs / scale;
  const frac = abs % scale;
  return { whole: negative ? -whole : whole, frac };
}

/** Thousands separators, applied to a bigint without going through Number. */
export function groupDigits(n: bigint): string {
  const negative = n < 0n;
  const digits = (negative ? -n : n).toString();
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return negative ? `-${out}` : out;
}

/**
 * Render base units as a human amount, e.g. 1_000_000_000_000n @ 6 => "1,000,000".
 *
 * Fractional digits are TRUNCATED, never rounded. Rounding a balance up would
 * let the UI advertise a redemption the treasury cannot actually pay.
 */
export function formatTokens(
  baseUnits: bigint,
  decimals: number,
  opts: { maxFractionDigits?: number } = {},
): string {
  const { whole, frac } = split(baseUnits, decimals);
  const maxFrac = opts.maxFractionDigits ?? 0;
  const head = groupDigits(whole);
  if (maxFrac === 0 || decimals === 0) return head;

  const fracStr = frac.toString().padStart(decimals, "0").slice(0, maxFrac);
  const trimmed = fracStr.replace(/0+$/, "");
  return trimmed ? `${head}.${trimmed}` : head;
}

/** Compact display for big treasury figures: 12,345,678 -> "12.34M". */
export function formatCompact(baseUnits: bigint, decimals: number): string {
  const { whole } = split(baseUnits, decimals);
  const abs = whole < 0n ? -whole : whole;
  const sign = whole < 0n ? "-" : "";

  const units: Array<[bigint, string]> = [
    [1_000_000_000n, "B"],
    [1_000_000n, "M"],
    [1_000n, "K"],
  ];
  for (const [threshold, suffix] of units) {
    if (abs >= threshold) {
      // Two decimal places via integer maths: multiply before dividing.
      const hundredths = (abs * 100n) / threshold;
      const w = hundredths / 100n;
      const f = hundredths % 100n;
      const fracStr = f.toString().padStart(2, "0").replace(/0+$/, "");
      return fracStr ? `${sign}${w}.${fracStr}${suffix}` : `${sign}${w}${suffix}`;
    }
  }
  return `${sign}${groupDigits(abs)}`;
}

/**
 * Parse a user-typed amount into base units. Rejects anything that is not a
 * plain decimal number — no exponents, no locale separators, no negatives.
 */
export function parseTokens(input: string, decimals: number): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`"${input}" is not a valid amount`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(`too many decimal places (max ${decimals})`);
  }
  const padded = frac.padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

/** Truncated middle for pubkeys: "AZxi6H7E…8MNU". */
export function shortAddress(address: string, lead = 4, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

export function explorerUrl(
  kind: "tx" | "address",
  value: string,
  cluster: string,
): string {
  const suffix = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;
  return `https://solscan.io/${kind === "tx" ? "tx" : "account"}/${value}${suffix}`;
}
