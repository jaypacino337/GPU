import { describe, expect, it } from "vitest";
import { formatEth, formatGwei, formatUnits, groupDigits, shortAddress } from "../src/engine/format";

describe("groupDigits", () => {
  it("groups in threes", () => {
    expect(groupDigits(1234567n)).toBe("1,234,567");
    expect(groupDigits(100n)).toBe("100");
    expect(groupDigits(1000n)).toBe("1,000");
    expect(groupDigits(0n)).toBe("0");
  });

  it("keeps the sign outside the grouping", () => {
    expect(groupDigits(-1234567n)).toBe("-1,234,567");
  });
});

describe("formatUnits", () => {
  it("renders base units at the token's decimals", () => {
    expect(formatUnits(1_284_120000n, 6)).toBe("1,284.12");
    expect(formatUnits(1_000_000n, 6)).toBe("1");
    expect(formatUnits(0n, 6)).toBe("0");
  });

  it("keeps negatives negative", () => {
    expect(formatUnits(-250_000000n, 6)).toBe("-250");
  });

  it("adds a plus only when asked, and only for positives", () => {
    expect(formatUnits(5_000000n, 6, { signed: true })).toBe("+5");
    expect(formatUnits(-5_000000n, 6, { signed: true })).toBe("-5");
    expect(formatUnits(0n, 6, { signed: true })).toBe("0");
  });

  /**
   * Rounding up in a balance diff would show a number the transaction does not
   * produce, so extra digits are dropped rather than rounded.
   */
  it("truncates rather than rounding", () => {
    expect(formatUnits(4999n, 4, { maxFractionDigits: 3 })).toBe("0.499");
    expect(formatUnits(999_999n, 6, { maxFractionDigits: 2 })).toBe("0.99");
  });

  it("drops trailing zeros in the fraction", () => {
    expect(formatUnits(1_500000n, 6)).toBe("1.5");
    expect(formatUnits(1_000000n, 6)).toBe("1");
  });

  it("handles sub-unit amounts", () => {
    expect(formatUnits(1n, 6)).toBe("0.000001");
    expect(formatUnits(1n, 18, { maxFractionDigits: 18 })).toBe("0.000000000000000001");
  });

  /**
   * The reason nothing here goes through Number: this value is far beyond
   * 2^53, and a double would silently round it.
   */
  it("stays exact past the safe-integer range", () => {
    const huge = 123_456_789_012_345_678_901_234_567_890n; // ~1.2e29
    expect(formatUnits(huge, 18, { maxFractionDigits: 18 })).toBe(
      "123,456,789,012.34567890123456789",
    );
  });

  it("handles zero decimals", () => {
    expect(formatUnits(42n, 0)).toBe("42");
  });

  it("rejects nonsense decimals rather than producing a wrong number", () => {
    expect(() => formatUnits(1n, -1)).toThrow(RangeError);
    expect(() => formatUnits(1n, 1.5)).toThrow(RangeError);
    expect(() => formatUnits(1n, 99)).toThrow(RangeError);
  });
});

describe("formatEth / formatGwei", () => {
  it("renders wei as ETH", () => {
    expect(formatEth(1_000_000_000_000_000_000n)).toBe("1 ETH");
    expect(formatEth(62_136_616_720_752n)).toBe("0.000062 ETH");
  });

  it("renders wei per gas as gwei", () => {
    expect(formatGwei(1_347_047_709n)).toBe("1.347 gwei");
    expect(formatGwei(1_000_000_000n)).toBe("1 gwei");
  });
});

describe("shortAddress", () => {
  it("truncates the middle", () => {
    expect(shortAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toBe("0xf39F…2266");
  });

  it("leaves something already short alone", () => {
    expect(shortAddress("0xabc")).toBe("0xabc");
  });
});
