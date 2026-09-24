import { describe, expect, it } from "vitest";
import { chunk, nextBatch } from "@/lib/batch";
import {
  avgAmountLastN,
  bucketPe,
  deriveDailyFeatures,
  deriveIntradayFeatures,
  derivePositionFeatures,
  filterCandidates,
  passesCoarseFilter,
  passesLiquidity5d,
  shouldScore,
  type DailyBar,
} from "@/lib/filter";
import {
  composeBuy,
  composeSell,
  parseNoul,
  parseScore,
  scoreIndexToDisplay,
  scoreIndexToProbability,
} from "@/lib/jev";
import { codeToMarket, limitPct, limitPrices, normalizeCode, toSecid } from "@/lib/market";
import { buyGate, discoverCap, reconcilePool, sellGate } from "@/lib/rules";
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
    expect(limitPct("sz", "300750")).toBe(0.2);
    expect(limitPct("sh", "688001")).toBe(0.2);
    expect(limitPct("bj", "830799")).toBe(0.3);
    expect(limitPct("sh", "600000")).toBe(0.1);
    expect(limitPrices(10, 0.1)).toEqual({ up: 11, down: 9 });
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
    expect(
      shouldScore(
        { name: "正常", price: 10, volume: 0, prevClose: 9.8, listDate: 20200101 },
        today
      )
    ).toEqual({ ok: true });
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
    const short = deriveDailyFeatures([
      { close: 10, high: 11, low: 9, volume: 100, amount: 1e8 },
      { close: 12, high: 13, low: 10, volume: 200, amount: 2e8 },
    ]);
    expect(short.ret20).toBeNull();
    expect(short.volVsAvg).toBeCloseTo(200 / 150);
    expect(short.avgAmount5).toBeCloseTo(1.5e8);
    expect(short.maAlign).toBe("mixed");

    const closes = Array.from({ length: 80 }, (_, i) => 10 + i * 0.05);
    const bars: DailyBar[] = closes.map((close, i) => ({
      date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
      open: close,
      close,
      high: close,
      low: close,
      volume: 1000,
      amount: close * 1000 * 100,
    }));
    bars[70] = {
      ...bars[70],
      close: bars[69].close * 1.11,
      high: bars[69].close * 1.11,
    };
    const f = deriveDailyFeatures(bars, { limitPct: 0.1 });
    expect(f.ret20).not.toBeNull();
    expect(f.maAlign).toBe("bull");
    expect(f.limitUpCount20).toBeGreaterThanOrEqual(1);
    expect(f.bias20).not.toBeNull();
    expect(bucketPe(-1)).toBe("neg");
    expect(bucketPe(20)).toBe("15-30");
    expect(bucketPe(0)).toBeNull();
  });

  it("derives intraday and position features", () => {
    const intra = deriveIntradayFeatures({
      bars5m: [
        { close: 11, high: 11, low: 11, volume: 100, amount: 110000, open: 11 },
      ],
      price: 11,
      prevClose: 10,
      open: 11,
      high: 11,
      low: 11,
      changePct: 0.1,
      todayVolume: 100,
      avgVol20: 100,
      sessionProgress: 0.5,
      maxHigh20Prev: 10.5,
      limitPct: 0.1,
      indexIntradayRet: 0,
    });
    expect(intra.isLimitUp).toBe(true);
    expect(intra.isOneWordBoard).toBe(true);
    expect(intra.vwap).toBeCloseTo(11);
    expect(intra.breakout20).toBe(true);

    const pos = derivePositionFeatures({
      entryPrice: 10,
      addedAt: "2026-09-01T01:00:00Z",
      price: 9,
      dailyBars: [
        { date: "2026-09-23", close: 10, high: 12, low: 9.5, volume: 1, amount: 1 },
        { date: "2026-09-24", close: 9, high: 9.2, low: 8.8, volume: 1, amount: 1 },
      ],
      now: new Date("2026-09-24T02:00:00Z"),
    });
    expect(pos.pnlPct).toBeCloseTo(-0.1);
    expect(pos.boughtToday).toBe(false);
    expect(pos.ddFromPeakPct).toBeCloseTo(9 / 12 - 1);
  });

  it("applies discover and trade gates", () => {
    expect(
      discoverCap({ ret20: 0.5, pos20: 0.95, limitUpCount20: 0, bias20: 0 })
        .cap
    ).toBe(44);
    expect(
      buyGate({
        isLimitUp: true,
        isOneWordBoard: false,
        isLimitDown: false,
        barsCount: 10,
        afterCloseAuction: false,
        ret20: 0,
        pos20: 0.5,
        limitUpCount20: 0,
        changePct: 0.1,
        wideLimit: false,
      })
    ).toMatchObject({ action: "force", probability: 0, tag: "涨停不可买" });
    expect(
      buyGate({
        isLimitUp: false,
        isOneWordBoard: false,
        isLimitDown: false,
        barsCount: 1,
        afterCloseAuction: false,
        ret20: 0,
        pos20: 0.5,
        limitUpCount20: 0,
        changePct: 0,
        wideLimit: false,
      }).action
    ).toBe("skip");
    expect(
      sellGate({
        isLimitUp: false,
        isLimitDown: true,
        boughtToday: false,
        afterCloseAuction: false,
        barsCount: 10,
        pnlPct: 0,
        belowAtrStop: false,
      })
    ).toMatchObject({ action: "force", probability: 1 });
    expect(
      sellGate({
        isLimitUp: false,
        isLimitDown: false,
        boughtToday: true,
        afterCloseAuction: false,
        barsCount: 10,
        pnlPct: -0.2,
        belowAtrStop: true,
      }).tag
    ).toBe("T+1 不可卖");
    expect(
      composeBuy(
        { chaseRisk: 0, strongerThanIndex: 1, validBreakout: 1, pullbackEntry: 0 },
        1
      )
    ).toBeCloseTo(1);
    expect(
      composeBuy(
        { chaseRisk: 1, strongerThanIndex: 1, validBreakout: 1, pullbackEntry: 1 },
        1
      )
    ).toBe(0);
    expect(
      composeSell({ trendBroken: 0, takeProfit: 0, dipIsMarketDriven: 1 })
    ).toBe(0);
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

describe("reconcilePool", () => {
  const base = {
    id: 1,
    market: "sh",
    code: "600000",
    starred: false,
    bearStreak: 0,
    score: 80,
  };

  it("keeps a healthy system stock and does not replace it", () => {
    const result = reconcilePool({
      pool: [base],
      trends: [{ id: 1, maAlign: "bull" }],
      suggestions: [
        {
          market: "sz",
          code: "000001",
          name: "新票",
          score: 99,
          maAlign: "bull",
          capped: false,
        },
      ],
      previousCodes: ["sz:000001"],
    });
    expect(result.removeIds).toEqual([]);
    expect(result.inserts.map((row) => row.code)).toEqual(["000001"]);
    expect(result.trendUpdates).toEqual([
      { id: 1, bearStreak: 0, trendTag: null },
    ]);
  });

  it("removes an unstarred stock only on the second bear check", () => {
    const once = reconcilePool({
      pool: [base],
      trends: [{ id: 1, maAlign: "bear" }],
      suggestions: [],
      previousCodes: [],
    });
    expect(once.removeIds).toEqual([]);
    expect(once.trendUpdates[0]?.bearStreak).toBe(1);

    const twice = reconcilePool({
      pool: [{ ...base, bearStreak: 1 }],
      trends: [{ id: 1, maAlign: "bear" }],
      suggestions: [],
      previousCodes: [],
    });
    expect(twice.removeIds).toEqual([1]);
  });

  it("flags a starred stock instead of removing it", () => {
    const result = reconcilePool({
      pool: [{ ...base, starred: true }],
      trends: [{ id: 1, maAlign: "bear" }],
      suggestions: [],
      previousCodes: [],
    });
    expect(result.removeIds).toEqual([]);
    expect(result.trendUpdates).toEqual([
      { id: 1, bearStreak: 0, trendTag: "趋势已破" },
    ]);
  });

  it("fills only the intersection of two rounds", () => {
    const suggestion = {
      market: "sz",
      code: "000001",
      name: "平安",
      score: 90,
      maAlign: "bull" as const,
      capped: false,
    };
    const missed = reconcilePool({
      pool: [],
      trends: [],
      suggestions: [suggestion],
      previousCodes: [],
    });
    expect(missed.inserts).toEqual([]);
    expect(missed.statuses[0]?.status).toBe("待第二轮");

    const hit = reconcilePool({
      pool: [],
      trends: [],
      suggestions: [suggestion],
      previousCodes: ["sz:000001"],
    });
    expect(hit.inserts).toEqual([
      { market: "sz", code: "000001", name: "平安", score: 90 },
    ]);
    expect(hit.statuses[0]?.status).toBe("本轮可补入");
  });

  it("does not insert past the system cap or when capped or not bull", () => {
    const pool = Array.from({ length: 10 }, (_, i) => ({
      ...base,
      id: i + 1,
      code: String(600000 + i),
    }));
    const full = reconcilePool({
      pool,
      trends: pool.map((row) => ({ id: row.id, maAlign: "bull" as const })),
      suggestions: [
        {
          market: "sz",
          code: "000001",
          name: "新票",
          score: 99,
          maAlign: "bull",
          capped: false,
        },
      ],
      previousCodes: ["sz:000001"],
    });
    expect(full.inserts).toEqual([]);
    expect(full.statuses[0]?.status).toBe("系统池已满");

    const blocked = reconcilePool({
      pool: [],
      trends: [],
      suggestions: [
        {
          market: "sz",
          code: "000001",
          name: "新票",
          score: 99,
          maAlign: "mixed",
          capped: false,
        },
        {
          market: "sz",
          code: "000002",
          name: "封顶",
          score: 99,
          maAlign: "bull",
          capped: true,
        },
      ],
      previousCodes: ["sz:000001", "sz:000002"],
    });
    expect(blocked.inserts).toEqual([]);
  });
});
