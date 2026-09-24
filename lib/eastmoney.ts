import { codeToMarket, toSecid, type Market } from "@/lib/market";
import { shanghaiYmd } from "@/lib/session";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const PUSH2_HOSTS = [
  "https://push2.eastmoney.com",
  "https://82.push2.eastmoney.com",
  "https://push2delay.eastmoney.com",
];

const HIS_HOSTS = [
  "https://79.push2his.eastmoney.com",
  "https://80.push2his.eastmoney.com",
  "https://81.push2his.eastmoney.com",
  "https://82.push2his.eastmoney.com",
  "https://91.push2his.eastmoney.com",
];

const EM_MAX_INFLIGHT = 2;
const EM_GAP_MS = 300;
const EM_FAIL_WAIT_MS = 1000;

export type MarketSnapshot = {
  market: Market;
  code: string;
  name: string;
  price: number;
  volume: number;
  changePct: number;
  amount: number;
  turnover: number;
  pe: number;
  volumeRatio: number;
  marketCap: number;
  pb: number;
  listDate: number | null;
};

export type KlineBar = {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  amount: number;
};

export type QuoteLite = {
  market: Market;
  code: string;
  name: string;
  price: number;
  changePct: number;
  volumeRatio: number;
  turnover: number;
  amount: number;
  open: number;
  high: number;
  low: number;
};

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

let emInflight = 0;
let emChain: Promise<void> = Promise.resolve();
let emLastAt = 0;

function withEmQueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    while (emInflight >= EM_MAX_INFLIGHT) {
      await sleep(50);
    }
    const wait = Math.max(0, EM_GAP_MS - (Date.now() - emLastAt));
    if (wait > 0) await sleep(wait);
    emInflight += 1;
    emLastAt = Date.now();
    try {
      return await fn();
    } finally {
      emInflight -= 1;
    }
  };
  const next = emChain.then(run, run);
  emChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function emFetch(pathAndQuery: string, hosts: string[]): Promise<unknown> {
  return withEmQueue(async () => {
    let lastErr: unknown;
    for (const host of hosts) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(`${host}${pathAndQuery}`, {
            headers: {
              "User-Agent": UA,
              Referer: "https://quote.eastmoney.com/",
            },
            cache: "no-store",
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) {
            lastErr = new Error(`东财请求失败 ${res.status}`);
            await sleep(EM_FAIL_WAIT_MS);
            continue;
          }
          return await res.json();
        } catch (e) {
          lastErr = e;
          await sleep(EM_FAIL_WAIT_MS);
        }
      }
      // 主站连续失败再换下一个镜像
    }
    throw lastErr instanceof Error ? lastErr : new Error("东财请求失败");
  });
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseListDate(v: unknown): number | null {
  if (v == null || v === "-" || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && String(Math.trunc(n)).length === 8
    ? Math.trunc(n)
    : null;
}

function mapDiff(f13: number, code: string): Market {
  try {
    const byCode = codeToMarket(code);
    if (byCode === "bj") return "bj";
    if (f13 === 1) return "sh";
    return byCode;
  } catch {
    return f13 === 1 ? "sh" : "sz";
  }
}

function parseClistItem(item: Record<string, unknown>): MarketSnapshot {
  const code = String(item.f12);
  const f13 = num(item.f13);
  return {
    market: mapDiff(f13, code),
    code,
    name: String(item.f14 ?? ""),
    price: num(item.f2),
    volume: num(item.f5),
    changePct: num(item.f3),
    amount: num(item.f6),
    turnover: num(item.f8),
    pe: num(item.f9),
    volumeRatio: num(item.f10),
    marketCap: num(item.f20),
    pb: num(item.f23),
    listDate: parseListDate(item.f26),
  };
}

function tencentSymbol(market: Market, code: string): string {
  return `${market}${code}`;
}

function parseKlineRow(row: string): KlineBar {
  const p = row.split(",");
  return {
    date: p[0],
    open: num(p[1]),
    close: num(p[2]),
    high: num(p[3]),
    low: num(p[4]),
    volume: num(p[5]),
    amount: num(p[6]),
  };
}

async function fetchDailyKlinesTencent(
  market: Market,
  code: string,
  lmt: number
): Promise<KlineBar[]> {
  const symbol = tencentSymbol(market, code);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${lmt},qfq`;
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`腾讯日K失败 ${res.status}`);
  const json = (await res.json()) as {
    data?: Record<string, { qfqday?: string[][]; day?: string[][] }>;
  };
  const rows = json.data?.[symbol]?.qfqday ?? json.data?.[symbol]?.day ?? [];
  return rows.map((r) => ({
    date: String(r[0]),
    open: num(r[1]),
    close: num(r[2]),
    high: num(r[3]),
    low: num(r[4]),
    volume: num(r[5]),
    amount: 0,
  }));
}

async function fetchMinuteKlinesTencent(
  market: Market,
  code: string,
  period: "m1" | "m5",
  lmt: number
): Promise<KlineBar[]> {
  const symbol = tencentSymbol(market, code);
  const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${symbol},${period},,${lmt}`;
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`腾讯分钟K失败 ${res.status}`);
  const json = (await res.json()) as {
    data?: Record<string, Record<string, string[][]>>;
  };
  const rows = json.data?.[symbol]?.[period] ?? [];
  return rows.map((r) => {
    const raw = String(r[0]);
    const date =
      raw.length >= 12
        ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(10, 12)}`
        : raw;
    return {
      date,
      open: num(r[1]),
      close: num(r[2]),
      high: num(r[3]),
      low: num(r[4]),
      volume: num(r[5]),
      amount: 0,
    };
  });
}

const CLIST_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048";
const CLIST_FIELDS = "f2,f5,f12,f13,f14,f3,f6,f8,f9,f10,f20,f23,f26";

export async function fetchEastmoneyPage(
  page: number,
  pageSize = 100
): Promise<{ items: MarketSnapshot[]; total: number }> {
  const path =
    `/api/qt/clist/get?pn=${page}&pz=${pageSize}&po=1&np=1&fltt=2&invt=2&fid=f12` +
    `&fs=${encodeURIComponent(CLIST_FS)}&fields=${CLIST_FIELDS}`;
  const json = (await emFetch(path, PUSH2_HOSTS)) as {
    data?: { total?: number; diff?: Record<string, unknown>[] };
  };
  const items = (json.data?.diff ?? []).map(parseClistItem);
  const total = json.data?.total ?? items.length;
  if (page === 1 && items.length === 0) throw new Error("东财快照为空");
  return { items, total };
}

type SinaRow = {
  symbol: string;
  code: string;
  name: string;
  trade: string | number;
  volume: number;
  changepercent: number;
  amount: number;
};

export async function fetchSinaPage(
  node: "hs_a" | "hs_bjs",
  page: number
): Promise<MarketSnapshot[]> {
  const pageSize = 80;
  const url =
    `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData` +
    `?page=${page}&num=${pageSize}&sort=amount&asc=0&node=${node}`;
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`新浪快照失败 ${res.status}`);
  const rows = (await res.json()) as SinaRow[];
  if (!Array.isArray(rows)) return [];
  const out: MarketSnapshot[] = [];
  for (const row of rows) {
    const code = String(row.code).padStart(6, "0");
    let market: Market;
    try {
      market = codeToMarket(code);
    } catch {
      continue;
    }
    out.push({
      market,
      code,
      name: row.name,
      price: num(row.trade),
      volume: num(row.volume),
      changePct: num(row.changepercent),
      amount: num(row.amount),
      turnover: 0,
      pe: 0,
      volumeRatio: 0,
      marketCap: 0,
      pb: 0,
      listDate: null,
    });
  }
  return out;
}

export async function fetchKlines(
  market: Market,
  code: string,
  opts: { klt: number; lmt: number }
): Promise<KlineBar[]> {
  const secid = toSecid(market, code);
  const path =
    `/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
    `&klt=${opts.klt}&fqt=1&end=20500101&lmt=${opts.lmt}`;

  try {
    const json = (await emFetch(path, HIS_HOSTS)) as {
      data?: { klines?: string[] };
    };
    const bars = (json.data?.klines ?? []).map(parseKlineRow);
    if (bars.length > 0) return bars;
  } catch {
    // fall through
  }

  if (opts.klt === 101) return fetchDailyKlinesTencent(market, code, opts.lmt);
  if (opts.klt === 5) return fetchMinuteKlinesTencent(market, code, "m5", opts.lmt);
  if (opts.klt === 1) return fetchMinuteKlinesTencent(market, code, "m1", opts.lmt);
  throw new Error(`无可用 K 线源 klt=${opts.klt}`);
}

export async function fetchDailyKlines(
  market: Market,
  code: string,
  lmt = 5
): Promise<KlineBar[]> {
  return fetchKlines(market, code, { klt: 101, lmt });
}

export async function fetchIntraday5m(
  market: Market,
  code: string,
  now: Date = new Date()
): Promise<KlineBar[]> {
  const bars = await fetchKlines(market, code, { klt: 5, lmt: 100 });
  const ymd = shanghaiYmd(now);
  return bars.filter(
    (b) => b.date.startsWith(ymd) || b.date.startsWith(ymd.replace(/-/g, ""))
  );
}

export async function fetchIndexContext(now: Date = new Date()): Promise<{
  intraday5m: KlineBar[];
  daily5: KlineBar[];
}> {
  const [intraday5m, daily5] = await Promise.all([
    fetchIntraday5m("sh", "000001", now),
    fetchDailyKlines("sh", "000001", 5),
  ]);
  return { intraday5m, daily5 };
}

export async function isShanghaiTradingDay(
  now: Date = new Date()
): Promise<boolean> {
  const bars = await fetchDailyKlines("sh", "000001", 1);
  if (bars.length === 0) return false;
  const ymd = shanghaiYmd(now);
  const d = bars[0].date;
  return (
    d.startsWith(ymd) ||
    d.replace(/-/g, "").startsWith(ymd.replace(/-/g, ""))
  );
}

export async function fetchQuotes(
  items: { market: Market; code: string }[]
): Promise<QuoteLite[]> {
  if (items.length === 0) return [];
  const secids = items.map((i) => toSecid(i.market, i.code)).join(",");
  const path =
    `/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f13,f14,f2,f3,f5,f6,f8,f10,f17,f15,f16&secids=${encodeURIComponent(secids)}`;
  const json = (await emFetch(path, PUSH2_HOSTS)) as {
    data?: { diff?: Record<string, unknown>[] };
  };
  return (json.data?.diff ?? []).map((item) => {
    const code = String(item.f12);
    return {
      market: mapDiff(num(item.f13), code),
      code,
      name: String(item.f14 ?? ""),
      price: num(item.f2),
      changePct: num(item.f3),
      volumeRatio: num(item.f10),
      turnover: num(item.f8),
      amount: num(item.f6),
      open: num(item.f17),
      high: num(item.f15),
      low: num(item.f16),
    };
  });
}

export async function resolveStock(code: string): Promise<{
  market: Market;
  code: string;
  name: string;
  price: number;
}> {
  const market = codeToMarket(code);
  try {
    const quotes = await fetchQuotes([{ market, code }]);
    const q = quotes[0];
    if (q?.name) {
      return {
        market: q.market,
        code: q.code,
        name: q.name,
        price: q.price,
      };
    }
  } catch {
    // fall through
  }
  const symbol = tencentSymbol(market, code);
  const mk = await fetch(
    `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${symbol},m5,,1`,
    { cache: "no-store", signal: AbortSignal.timeout(10000) }
  );
  const mkJson = (await mk.json()) as {
    data?: Record<string, { qt?: Record<string, string[]> }>;
  };
  const qt = mkJson.data?.[symbol]?.qt?.[symbol];
  const name = qt?.[1];
  const price = num(qt?.[3]);
  if (!name) throw new Error(`找不到股票: ${code}`);
  return { market, code, name, price };
}

export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}
