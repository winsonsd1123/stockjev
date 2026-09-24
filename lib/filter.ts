export type SnapshotLike = {
  name: string;
  /** 成交额（元）——快照仅供参考，流动性改看近5日均额 */
  amount?: number;
  /** 最新价 */
  price?: number;
  /** 成交量 */
  volume?: number;
  /** 昨收；有值时用它判停牌，不再看当日成交量 */
  prevClose?: number | null;
  /** 上市日 YYYYMMDD 或 null */
  listDate: number | null;
};

const MIN_AVG_AMOUNT_5D = 50_000_000; // 近5日日均成交额 5000 万
const MIN_LIST_DAYS = 60;

function daysSinceList(listDate: number, today: Date): number {
  const s = String(listDate);
  if (s.length !== 8) return 0;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const listed = new Date(y, m - 1, d);
  const ms = today.getTime() - listed.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * 快照级初筛（不含成交额）。
 * 流动性改由近5日日均成交额判定，需日K后再查。
 */
export function shouldScore(
  snap: SnapshotLike,
  today: Date = new Date()
): { ok: true } | { ok: false; reason: string } {
  const name = snap.name ?? "";
  if (/ST/i.test(name)) return { ok: false, reason: "ST" };
  if (snap.listDate != null && daysSinceList(snap.listDate, today) < MIN_LIST_DAYS) {
    return { ok: false, reason: "上市不足60天" };
  }
  if (!(snap.price != null && snap.price > 0)) {
    return { ok: false, reason: "停牌或缺价量" };
  }
  if (snap.prevClose != null) {
    if (!(snap.prevClose > 0)) return { ok: false, reason: "停牌或缺价量" };
  } else if (!(snap.volume != null && snap.volume > 0)) {
    return { ok: false, reason: "停牌或缺价量" };
  }
  return { ok: true };
}

/** @deprecated 兼容旧名；等同 shouldScore.ok */
export function passesCoarseFilter(
  snap: SnapshotLike,
  today: Date = new Date()
): boolean {
  return shouldScore(snap, today).ok;
}

export function filterCandidates<T extends SnapshotLike>(
  items: T[],
  today: Date = new Date()
): T[] {
  return items.filter((item) => passesCoarseFilter(item, today));
}

export type DailyBar = {
  date?: string;
  open?: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  amount: number;
};

export type MaAlign = "bull" | "bear" | "mixed";

export type DailyFeatures = {
  ret5: number | null;
  ret20: number | null;
  ret60: number | null;
  ret120: number | null;
  pos20: number | null;
  pos60: number | null;
  pos120: number | null;
  ddFromHigh60: number | null;
  bias20: number | null;
  bias60: number | null;
  maAlign: MaAlign;
  vol20Ann: number | null;
  atrPct14: number | null;
  volRatio5_20: number | null;
  volRatio20_60: number | null;
  upDays20: number;
  maxUpStreak20: number;
  limitUpCount20: number;
  limitDownCount20: number;
  gapUpToday: number | null;
  ampToday: number | null;
  rs20: number | null;
  rs60: number | null;
  volVsAvg: number;
  avgAmount5: number;
};

/** 单根日 K 成交额（元）；缺 amount 时按 收盘价×手数×100 估算（腾讯日K无额） */
function barAmountYuan(b: DailyBar): number {
  if (b.amount > 0) return b.amount;
  if (b.close > 0 && b.volume > 0) return b.close * b.volume * 100;
  return 0;
}

/** 近 N 根日 K 的日均成交额（元） */
export function avgAmountLastN(bars: DailyBar[], n = 5): number {
  if (bars.length === 0) return 0;
  const slice = bars.slice(-n);
  const sum = slice.reduce((acc, b) => acc + barAmountYuan(b), 0);
  return sum / slice.length;
}

/** 近5日日均成交额是否达标 */
export function passesLiquidity5d(
  bars: DailyBar[]
): { ok: true; avgAmount: number } | { ok: false; reason: string; avgAmount: number } {
  const avgAmount = avgAmountLastN(bars, 5);
  if (avgAmount < MIN_AVG_AMOUNT_5D) {
    return { ok: false, reason: "近5日均额不足", avgAmount };
  }
  return { ok: true, avgAmount };
}

function retOver(bars: DailyBar[], n: number): number | null {
  if (bars.length < n + 1) return null;
  const prev = bars[bars.length - 1 - n].close;
  const last = bars[bars.length - 1].close;
  if (!(prev > 0)) return null;
  return last / prev - 1;
}

function posOver(bars: DailyBar[], n: number): number | null {
  if (bars.length < n) return null;
  const w = bars.slice(-n);
  let hi = -Infinity;
  let lo = Infinity;
  for (const b of w) {
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  const span = hi - lo;
  const last = w[w.length - 1].close;
  return span > 0 ? (last - lo) / span : 0.5;
}

function sma(bars: DailyBar[], n: number): number | null {
  if (bars.length < n) return null;
  const w = bars.slice(-n);
  return w.reduce((acc, b) => acc + b.close, 0) / n;
}

function avgVol(bars: DailyBar[], n: number): number | null {
  if (bars.length < n) return null;
  const w = bars.slice(-n);
  return w.reduce((acc, b) => acc + b.volume, 0) / n;
}

/** 近 N 日（不含最后一根，视为今日）的最高价 */
export function priorHigh(bars: DailyBar[], n = 20): number | null {
  if (bars.length < n + 1) return null;
  const w = bars.slice(-(n + 1), -1);
  return Math.max(...w.map((b) => b.high));
}

/** 近 N 日（不含最后一根）的均量 */
export function priorAvgVolume(bars: DailyBar[], n = 20): number | null {
  if (bars.length < n + 1) return null;
  const w = bars.slice(-(n + 1), -1);
  return w.reduce((acc, b) => acc + b.volume, 0) / n;
}

function countLimitMoves(
  bars: DailyBar[],
  pct: number,
  dir: 1 | -1
): number {
  const w = bars.slice(-21);
  let n = 0;
  for (let i = 1; i < w.length; i++) {
    const prev = w[i - 1].close;
    if (!(prev > 0)) continue;
    const chg = w[i].close / prev - 1;
    if (dir === 1 ? chg >= pct - 0.002 : chg <= -(pct - 0.002)) n += 1;
  }
  return n;
}

/** 由日 K 派生观察特征。涨跌幅为小数（0.1 = 10%）。样本不足的窗口返回 null。 */
export function deriveDailyFeatures(
  bars: DailyBar[],
  opts?: { limitPct?: number; indexBars?: DailyBar[] }
): DailyFeatures {
  const empty: DailyFeatures = {
    ret5: null,
    ret20: null,
    ret60: null,
    ret120: null,
    pos20: null,
    pos60: null,
    pos120: null,
    ddFromHigh60: null,
    bias20: null,
    bias60: null,
    maAlign: "mixed",
    vol20Ann: null,
    atrPct14: null,
    volRatio5_20: null,
    volRatio20_60: null,
    upDays20: 0,
    maxUpStreak20: 0,
    limitUpCount20: 0,
    limitDownCount20: 0,
    gapUpToday: null,
    ampToday: null,
    rs20: null,
    rs60: null,
    volVsAvg: 1,
    avgAmount5: 0,
  };
  if (bars.length === 0) return empty;

  const last = bars[bars.length - 1];
  const ret5 = retOver(bars, 5);
  const ret20 = retOver(bars, 20);
  const ret60 = retOver(bars, 60);
  const ret120 = retOver(bars, 120);
  const ma20 = sma(bars, 20);
  const ma60 = sma(bars, 60);
  const bias20 = ma20 && ma20 > 0 ? last.close / ma20 - 1 : null;
  const bias60 = ma60 && ma60 > 0 ? last.close / ma60 - 1 : null;
  let maAlign: MaAlign = "mixed";
  if (ma20 != null && ma60 != null) {
    if (last.close > ma20 && ma20 > ma60) maAlign = "bull";
    else if (last.close < ma20 && ma20 < ma60) maAlign = "bear";
  }

  let vol20Ann: number | null = null;
  if (bars.length >= 21) {
    const w = bars.slice(-21);
    const rets: number[] = [];
    for (let i = 1; i < w.length; i++) {
      if (!(w[i - 1].close > 0) || !(w[i].close > 0)) {
        rets.length = 0;
        break;
      }
      rets.push(Math.log(w[i].close / w[i - 1].close));
    }
    if (rets.length >= 2) {
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const variance =
        rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
      vol20Ann = Math.sqrt(variance) * Math.sqrt(242);
    }
  }

  let atrPct14: number | null = null;
  if (bars.length >= 15) {
    const w = bars.slice(-15);
    let sum = 0;
    for (let i = 1; i < w.length; i++) {
      const prev = w[i - 1].close;
      const tr = Math.max(
        w[i].high - w[i].low,
        Math.abs(w[i].high - prev),
        Math.abs(w[i].low - prev)
      );
      sum += tr;
    }
    const atr = sum / 14;
    atrPct14 = last.close > 0 ? atr / last.close : null;
  }

  const v5 = avgVol(bars, 5);
  const v20 = avgVol(bars, 20);
  const v60 = avgVol(bars, 60);
  const changes = bars.slice(-21);
  let upDays20 = 0;
  let streak = 0;
  let maxUpStreak20 = 0;
  for (let i = 1; i < changes.length; i++) {
    if (changes[i].close > changes[i - 1].close) {
      upDays20 += 1;
      streak += 1;
      if (streak > maxUpStreak20) maxUpStreak20 = streak;
    } else {
      streak = 0;
    }
  }

  const pct = opts?.limitPct ?? 0.1;
  let ddFromHigh60: number | null = null;
  if (bars.length >= 60) {
    const hi = Math.max(...bars.slice(-60).map((b) => b.high));
    ddFromHigh60 = hi > 0 ? last.close / hi - 1 : null;
  }

  const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
  const gapUpToday =
    prev && prev.close > 0 && last.open != null && last.open > 0
      ? last.open / prev.close - 1
      : null;
  const ampToday =
    prev && prev.close > 0 ? (last.high - last.low) / prev.close : null;

  const idx = opts?.indexBars;
  const idxRet20 = idx ? retOver(idx, 20) : null;
  const idxRet60 = idx ? retOver(idx, 60) : null;
  const volSum = bars.reduce((a, b) => a + b.volume, 0);
  const meanVol = volSum / bars.length;

  return {
    ret5,
    ret20,
    ret60,
    ret120,
    pos20: posOver(bars, 20),
    pos60: posOver(bars, 60),
    pos120: posOver(bars, 120),
    ddFromHigh60,
    bias20,
    bias60,
    maAlign,
    vol20Ann,
    atrPct14,
    volRatio5_20: v5 != null && v20 != null && v20 > 0 ? v5 / v20 : null,
    volRatio20_60: v20 != null && v60 != null && v60 > 0 ? v20 / v60 : null,
    upDays20,
    maxUpStreak20,
    limitUpCount20: countLimitMoves(bars, pct, 1),
    limitDownCount20: countLimitMoves(bars, pct, -1),
    gapUpToday,
    ampToday,
    rs20: ret20 != null && idxRet20 != null ? ret20 - idxRet20 : null,
    rs60: ret60 != null && idxRet60 != null ? ret60 - idxRet60 : null,
    volVsAvg: meanVol > 0 ? last.volume / meanVol : 1,
    avgAmount5: avgAmountLastN(bars, 5),
  };
}

export function bucketPe(pe: number | null | undefined): string | null {
  if (pe == null || !Number.isFinite(pe) || pe === 0) return null;
  if (pe < 0) return "neg";
  if (pe < 15) return "<15";
  if (pe < 30) return "15-30";
  if (pe < 60) return "30-60";
  return ">60";
}

export function bucketPb(pb: number | null | undefined): string | null {
  if (pb == null || !Number.isFinite(pb) || pb === 0) return null;
  if (pb < 0) return "neg";
  if (pb < 1) return "<1";
  if (pb < 3) return "1-3";
  if (pb < 6) return "3-6";
  return ">6";
}

/** marketCap 单位：元 */
export function bucketCap(marketCap: number | null | undefined): string | null {
  if (marketCap == null || !Number.isFinite(marketCap) || marketCap <= 0) {
    return null;
  }
  const yi = marketCap / 1e8;
  if (yi < 50) return "<50亿";
  if (yi < 200) return "50-200亿";
  if (yi < 1000) return "200-1000亿";
  return ">1000亿";
}

export type IntradayFeatures = {
  intradayRet: number | null;
  vwap: number | null;
  vwapDevPct: number | null;
  posInDayRange: number | null;
  rsIntraday: number | null;
  barsCount: number;
  isLimitUp: boolean;
  isLimitDown: boolean;
  isOneWordBoard: boolean;
  distToLimitUpPct: number | null;
  breakout20: boolean;
  volRatioNow: number | null;
  changePct: number | null;
  ampToday: number | null;
  gapUpToday: number | null;
};

export function deriveIntradayFeatures(input: {
  bars5m: DailyBar[];
  price: number;
  prevClose: number | null;
  open: number;
  high: number;
  low: number;
  /** 小数，0.02 = +2% */
  changePct: number | null;
  todayVolume: number;
  avgVol20: number | null;
  /** 已开盘时间占全天 240 分钟的比例 */
  sessionProgress: number;
  maxHigh20Prev: number | null;
  limitPct: number;
  indexIntradayRet: number | null;
}): IntradayFeatures {
  const {
    bars5m,
    price,
    prevClose,
    open,
    high,
    low,
    changePct,
    todayVolume,
    avgVol20,
    sessionProgress,
    maxHigh20Prev,
    limitPct: pct,
    indexIntradayRet,
  } = input;

  let amountSum = 0;
  let volSum = 0;
  for (const b of bars5m) {
    if (b.amount > 0 && b.volume > 0) {
      amountSum += b.amount;
      volSum += b.volume;
    }
  }
  const vwap = volSum > 0 ? amountSum / (volSum * 100) : null;
  const intradayRet =
    prevClose != null && prevClose > 0 && price > 0 ? price / prevClose - 1 : null;
  const span = high - low;
  const limits =
    prevClose != null && prevClose > 0
      ? {
          up: Math.round(prevClose * (1 + pct) * 100) / 100,
          down: Math.round(prevClose * (1 - pct) * 100) / 100,
        }
      : null;
  const isLimitUp = limits != null && price >= limits.up - 0.005;
  const isLimitDown = limits != null && price <= limits.down + 0.005;
  const same =
    open > 0 &&
    Math.abs(open - high) < 0.011 &&
    Math.abs(high - low) < 0.011 &&
    Math.abs(low - price) < 0.011;
  const progress = Math.min(1, Math.max(sessionProgress, 1 / 48));

  return {
    intradayRet,
    vwap,
    vwapDevPct: vwap != null && vwap > 0 && price > 0 ? price / vwap - 1 : null,
    posInDayRange: span > 0 ? (price - low) / span : null,
    rsIntraday:
      intradayRet != null && indexIntradayRet != null
        ? intradayRet - indexIntradayRet
        : null,
    barsCount: bars5m.length,
    isLimitUp,
    isLimitDown,
    isOneWordBoard: Boolean(same && isLimitUp),
    distToLimitUpPct:
      limits != null && prevClose != null && prevClose > 0
        ? (limits.up - price) / prevClose
        : null,
    breakout20: maxHigh20Prev != null && price > maxHigh20Prev,
    volRatioNow:
      avgVol20 != null && avgVol20 > 0 ? todayVolume / (avgVol20 * progress) : null,
    changePct,
    ampToday:
      prevClose != null && prevClose > 0 ? (high - low) / prevClose : null,
    gapUpToday:
      prevClose != null && prevClose > 0 && open > 0
        ? open / prevClose - 1
        : null,
  };
}

export type PositionFeatures = {
  pnlPct: number | null;
  holdingDays: number | null;
  boughtToday: boolean;
  peakSinceEntry: number | null;
  ddFromPeakPct: number | null;
  giveBackRatio: number | null;
  belowMA20: boolean;
  belowAtrStop: boolean;
};

function ymdOf(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function derivePositionFeatures(input: {
  entryPrice: number | null;
  addedAt: string | null;
  price: number;
  dailyBars: DailyBar[];
  now?: Date;
}): PositionFeatures {
  const { entryPrice, addedAt, price, dailyBars } = input;
  const now = input.now ?? new Date();
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const addedYmd = addedAt ? ymdOf(addedAt) : null;
  const boughtToday = addedYmd != null && addedYmd === today;
  const pnlPct =
    entryPrice != null && entryPrice > 0 && price > 0
      ? price / entryPrice - 1
      : null;

  const held = addedYmd
    ? dailyBars.filter((b) => (b.date ?? "") >= addedYmd)
    : dailyBars;
  const peak =
    held.length > 0 ? Math.max(...held.map((b) => b.high), price) : price > 0 ? price : null;
  const ddFromPeakPct = peak != null && peak > 0 && price > 0 ? price / peak - 1 : null;
  const giveBackRatio =
    peak != null && entryPrice != null && peak > entryPrice
      ? (peak - price) / (peak - entryPrice)
      : null;

  const ma20 = sma(dailyBars, 20);
  let atr: number | null = null;
  if (dailyBars.length >= 15) {
    const w = dailyBars.slice(-15);
    let sum = 0;
    for (let i = 1; i < w.length; i++) {
      const prev = w[i - 1].close;
      sum += Math.max(
        w[i].high - w[i].low,
        Math.abs(w[i].high - prev),
        Math.abs(w[i].low - prev)
      );
    }
    atr = sum / 14;
  }
  const belowAtrStop =
    peak != null && atr != null && price > 0 && price < peak - 2 * atr;

  return {
    pnlPct,
    holdingDays: addedYmd ? held.length : null,
    boughtToday,
    peakSinceEntry: peak,
    ddFromPeakPct,
    giveBackRatio,
    belowMA20: ma20 != null && price > 0 && price < ma20,
    belowAtrStop,
  };
}
