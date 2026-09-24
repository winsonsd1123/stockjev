import { describe, expect, it } from "vitest";
import { chunk, nextBatch } from "@/lib/batch";
import {
  avgAmountLastN,
  deriveDailyFeatures,
  filterCandidates,
  passesCoarseFilter,
  passesLiquidity5d,
  shouldScore,
} from "@/lib/filter";
import {
  parseNoul,
  parseScore,
  scoreIndexToDisplay,
  scoreIndexToProbability,
} from "@/lib/jev";
import { codeToMarket, normalizeCode, toSecid } from "@/lib/market";
import { isTradingSession, shanghaiYmd } from "@/lib/session";

describe("market", () => {
  it("maps prefixes", () => {
    expect(codeToMarket("600000")).toBe("sh");
    expect(codeToMarket("688001")).toBe("sh");
    expect(codeToMarket("000001")).toBe("sz");
    expect(codeToMarket("300750")).toBe("sz");
    expect(codeToMarket("830799")).toBe("bj");
    expect(toSecid("sh", "600000")).toBe("1.600000");
    expect(toSecid("sz", "000001")).toBe("0.000001");
    expect(toSecid("bj", "830799")).toBe("0.830799");
  });

  it("normalizes code", () => {
    expect(normalizeCode(" 600519 ")).toBe("600519");
    expect(() => normalizeCode("abc")).toThrow();
  });
});

describe("filter", () => {
  const today = new Date(2026, 8, 24);

  it("rejects ST new listings and halt; amount not in snapshot gate", () => {
    expect(
      passesCoarseFilter(
        { name: "ST测试", price: 10, volume: 1, listDate: 20200101 },
        today
      )
    ).toBe(false);
    expect(
      passesCoarseFilter(
        { name: "正常", price: 10, volume: 1, listDate: 20260801 },
        today
      )
    ).toBe(false);
    expect(
      shouldScore(
        { name: "正常", price: 0, volume: 1, listDate: 20200101 },
        today
      )
    ).toEqual({ ok: false, reason: "停牌或缺价量" });
    expect(
      passesCoarseFilter(
        { name: "正常", price: 10, volume: 100, listDate: 20200101 },
        today
      )
    ).toBe(true);
  });

  it("checks 5-day average amount liquidity", () => {
    const rich = Array.from({ length: 5 }, () => ({
      close: 10,
      high: 11,
      low: 9,
      volume: 100,
      amount: 80_000_000,
    }));
    const poor = Array.from({ length: 5 }, () => ({
      close: 10,
      high: 11,
      low: 9,
      volume: 100,
      amount: 10_000_000,
    }));
    expect(passesLiquidity5d(rich).ok).toBe(true);
    expect(passesLiquidity5d(poor).ok).toBe(false);
    expect(avgAmountLastN(rich, 5)).toBe(80_000_000);
  });

  it("estimates amount from close*volume*100 when amount missing", () => {
    const estimated = Array.from({ length: 5 }, () => ({
      close: 10,
      high: 11,
      low: 9,
      volume: 100_000, // 手 → 约 1e8 元
      amount: 0,
    }));
    expect(avgAmountLastN(estimated, 5)).toBe(100_000_000);
    expect(passesLiquidity5d(estimated).ok).toBe(true);
  });

  it("derives daily features", () => {
    const f = deriveDailyFeatures([
      { close: 10, high: 11, low: 9, volume: 100, amount: 1e8 },
      { close: 12, high: 13, low: 10, volume: 200, amount: 2e8 },
    ]);
    expect(f.ret20).toBeCloseTo(0.2);
    expect(f.volVsAvg).toBeCloseTo(200 / 150);
    expect(f.avgAmount5).toBeCloseTo(1.5e8);
  });

  it("filters list", () => {
    const out = filterCandidates(
      [
        { name: "*ST差", price: 1, volume: 1, listDate: 20200101 },
        { name: "好", price: 1, volume: 1, listDate: 20200101 },
      ],
      today
    );
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("好");
  });
});

describe("batch", () => {
  it("chunks and nextBatch", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(nextBatch([1, 2, 3, 4], 0, 3)).toEqual({
      batch: [1, 2, 3],
      nextCursor: 3,
      done: false,
    });
    expect(nextBatch([1, 2, 3, 4], 3, 3)).toEqual({
      batch: [4],
      nextCursor: 4,
      done: true,
    });
  });
});

describe("session", () => {
  it("uses continuous 9:30-15:00 window", () => {
    const morning = new Date("2026-09-24T02:00:00Z");
    expect(isTradingSession(true, morning)).toBe(true);
    const noon = new Date("2026-09-24T04:00:00Z");
    expect(isTradingSession(true, noon)).toBe(true);
    const afternoon = new Date("2026-09-24T06:00:00Z");
    expect(isTradingSession(true, afternoon)).toBe(true);
    const afterClose = new Date("2026-09-24T07:30:00Z");
    expect(isTradingSession(true, afterClose)).toBe(false);
    expect(isTradingSession(false, afternoon)).toBe(false);
  });

  it("formats shanghai ymd", () => {
    expect(shanghaiYmd(new Date("2026-09-24T02:00:00Z"))).toBe("2026-09-24");
  });
});

describe("jev parse", () => {
  it("maps score index to display and probability", () => {
    expect(scoreIndexToDisplay(0)).toBe(0);
    expect(scoreIndexToDisplay(9)).toBe(100);
    expect(scoreIndexToDisplay(4.5)).toBe(50);
    expect(scoreIndexToProbability(9)).toBe(1);
  });

  it("parses noul and score answers", () => {
    const response = {
      answers: {
        buy: { type: "noul" as const, noul: 0.72 },
        excellence: {
          type: "score" as const,
          score: 8.1,
          confidence: 0.9,
          legend: { "0": "0", "9": "100" },
          probabilities: { "8": 0.8, "9": 0.2 },
        },
      },
    };
    expect(parseNoul(response, "buy").probability).toBe(0.72);
    const s = parseScore(response, "excellence");
    expect(s.displayScore).toBe(90);
    expect(s.probability).toBeCloseTo(0.9);
  });
});
