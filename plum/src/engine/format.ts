/**
 * Presentation formatting.
 *
 * Kept out of the engine on purpose: findings and deltas carry base units so
 * they stay exact and comparable, and formatting happens once, at the edge,
 * where a human reads it.
 *
 * Nothing here converts an amount through `number`. A USDC balance at 6
 * decimals is fine in a double; 18-decimal amounts are not, and a formatter
 * that quietly loses precision on large balances is worse than no formatter.
 */

/** Group digits without going through Number. */
export function groupDigits(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return negative ? `-${out}` : out;
}

export interface FormatOptions {
  /** Maximum fractional digits to show. Extra digits are TRUNCATED, not rounded. */
  maxFractionDigits?: number;
  /** Always show a leading + for positive values. Useful in a diff. */
  signed?: boolean;
}

/**
 * Render base units as a decimal string.
 *
 * Truncates rather than rounds. In a balance diff, rounding 0.4999 up to 0.5
 * would show someone a number their transaction does not produce.
 */
export function formatUnits(
  baseUnits: bigint,
  decimals: number,
  options: FormatOptions = {},
): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError(`Invalid decimals: ${decimals}`);
  }

  const negative = baseUnits < 0n;
  const abs = negative ? -baseUnits : baseUnits;
  const scale = 10n ** BigInt(decimals);

  const whole = abs / scale;
  const fraction = abs % scale;

  const maxFraction = options.maxFractionDigits ?? Math.min(decimals, 6);
  let text = groupDigits(whole);

  if (maxFraction > 0 && decimals > 0) {
    const padded = fraction.toString().padStart(decimals, "0").slice(0, maxFraction);
    const trimmed = padded.replace(/0+$/, "");
    if (trimmed) text += `.${trimmed}`;
  }

  if (negative) return `-${text}`;
  if (options.signed && baseUnits > 0n) return `+${text}`;
  return text;
}

/** Wei rendered as ETH, at the precision a fee line actually needs. */
export function formatEth(wei: bigint): string {
  return `${formatUnits(wei, 18, { maxFractionDigits: 6 })} ETH`;
}

/** Wei per gas rendered as gwei. */
export function formatGwei(weiPerGas: bigint): string {
  return `${formatUnits(weiPerGas, 9, { maxFractionDigits: 3 })} gwei`;
}

export function shortAddress(address: string, lead = 6, tail = 4): string {
  return address.length > lead + tail + 1
    ? `${address.slice(0, lead)}…${address.slice(-tail)}`
    : address;
}
