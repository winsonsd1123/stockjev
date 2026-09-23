import { describe, expect, it } from "vitest";
import { chunk, nextBatch } from "@/lib/batch";
import { filterCandidates, passesCoarseFilter } from "@/lib/filter";
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
  const today = new Date(2026, 8, 24); // Sep 24 2026

  it("rejects ST and low amount and new listings", () => {
    expect(
      passesCoarseFilter(
        { name: "ST测试", amount: 1e8, listDate: 20200101 },
        today
      )
    ).toBe(false);
    expect(
      passesCoarseFilter(
        { name: "正常", amount: 1e7, listDate: 20200101 },
        today
      )
    ).toBe(false);
    expect(
      passesCoarseFilter(
        { name: "正常", amount: 1e8, listDate: 20260801 },
        today
      )
    ).toBe(false);
    expect(
      passesCoarseFilter(
        { name: "正常", amount: 1e8, listDate: 20200101 },
        today
      )
    ).toBe(true);
  });

  it("filters list", () => {
    const out = filterCandidates(
      [
        { name: "*ST差", amount: 1e9, listDate: 20200101 },
        { name: "好", amount: 1e9, listDate: 20200101 },
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
  it("detects trading windows on trading day", () => {
    // 2026-09-24 10:00 Asia/Shanghai = 2026-09-24 02:00 UTC
    const morning = new Date("2026-09-24T02:00:00Z");
    expect(isTradingSession(true, morning)).toBe(true);
    // 12:00 Shanghai = 04:00 UTC
    const noon = new Date("2026-09-24T04:00:00Z");
    expect(isTradingSession(true, noon)).toBe(false);
    // 14:00 Shanghai = 06:00 UTC
    const afternoon = new Date("2026-09-24T06:00:00Z");
    expect(isTradingSession(true, afternoon)).toBe(true);
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
    expect(s.details.displayScore).toBe(90);
  });
});
