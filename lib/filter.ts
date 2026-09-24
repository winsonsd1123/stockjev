export type SnapshotLike = {
  name: string;
  /** 成交额（元）——快照仅供参考，流动性改看近5日均额 */
  amount?: number;
  /** 最新价 */
  price?: number;
  /** 成交量 */
  volume?: number;
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
  if (!(snap.price != null && snap.price > 0) || !(snap.volume != null && snap.volume > 0)) {
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
  close: number;
  high: number;
  low: number;
  volume: number;
  amount: number;
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

/** 由近 N 日 K 派生三个特征 */
export function deriveDailyFeatures(bars: DailyBar[]): {
  ret20: number;
  posInRange: number;
  volVsAvg: number;
  avgAmount5: number;
} {
  if (bars.length === 0) {
    return { ret20: 0, posInRange: 0.5, volVsAvg: 1, avgAmount5: 0 };
  }
  const first = bars[0].close;
  const last = bars[bars.length - 1].close;
  const ret20 = first > 0 ? (last - first) / first : 0;
  let hi = -Infinity;
  let lo = Infinity;
  let volSum = 0;
  for (const b of bars) {
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
    volSum += b.volume;
  }
  const span = hi - lo;
  const posInRange = span > 0 ? (last - lo) / span : 0.5;
  const avgVol = volSum / bars.length;
  const volVsAvg = avgVol > 0 ? bars[bars.length - 1].volume / avgVol : 1;
  return {
    ret20,
    posInRange,
    volVsAvg,
    avgAmount5: avgAmountLastN(bars, 5),
  };
}
