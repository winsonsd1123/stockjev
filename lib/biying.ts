import { codeToMarket, type Market } from "@/lib/market";
import type {
  KlineBar,
  MarketData,
  MarketSnapshot,
  QuoteLite,
} from "@/lib/market-data";
import { shanghaiYmd } from "@/lib/session";

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 240;
const MIN_GAP_MS = 250;
const LIST_TTL_MS = 60 * 60 * 1000;
const QUOTE_TTL_MS = 10 * 60 * 1000;

type ListItem = { dm: string; mc: string; jys: string };
type Realtime = {
  p?: number;
  o?: number;
  h?: number;
  l?: number;
  hs?: number;
  lb?: number;
  pe?: number;
  pc?: number;
  sz?: number;
  cje?: number;
  v?: number;
  yc?: number;
  sjl?: number;
  zdf60?: number;
};
type RawBar = {
  t?: string;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
  a?: number;
};

type RateGate = { chain: Promise<void>; stamps: number[] };

function rateGate(): RateGate {
  const g = globalThis as typeof globalThis & { __biyingRateGate?: RateGate };
  if (!g.__biyingRateGate) {
    g.__biyingRateGate = { chain: Promise.resolve(), stamps: [] };
  }
  return g.__biyingRateGate;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function licence(): string {
  const key = process.env.biying_api_key?.trim();
  if (!key) throw new Error("缺少 biying_api_key");
  return key;
}

function withQueue<T>(fn: () => Promise<T>): Promise<T> {
  const gate = rateGate();
  const run = async () => {
    for (;;) {
      const now = Date.now();
      gate.stamps = gate.stamps.filter((t) => now - t < WINDOW_MS);
      const last = gate.stamps[gate.stamps.length - 1];
      if (gate.stamps.length >= MAX_PER_WINDOW) {
        await sleep(WINDOW_MS - (now - gate.stamps[0]) + 20);
        continue;
      }
      if (last != null && now - last < MIN_GAP_MS) {
        await sleep(MIN_GAP_MS - (now - last));
        continue;
      }
      gate.stamps.push(Date.now());
      return fn();
    }
  };
  const next = gate.chain.then(run, run);
  gate.chain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function biyingGet(url: string): Promise<unknown> {
  return withQueue(async () => {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`必盈请求失败 ${res.status} ${text.slice(0, 80)}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`必盈返回非 JSON ${text.slice(0, 80)}`);
    }
  });
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "-" || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function suffix(market: Market): string {
  if (market === "sh") return "SH";
  if (market === "sz") return "SZ";
  return "BJ";
}

function toMarket(jys: string, code: string): Market {
  const m = jys.toLowerCase();
  if (m === "sh" || m === "sz" || m === "bj") return m;
  return codeToMarket(code);
}

/** 列表代码实为 000001.SZ，文档示例是 6 位。两种都收下。 */
function parseListed(dm: string, jys: string): { code: string; market: Market } | null {
  const raw = dm.trim();
  const [head, tail] = raw.split(".");
  const code = head.padStart(6, "0");
  if (!/^\d{6}$/.test(code)) return null;
  const fromTail = (tail ?? jys).toLowerCase();
  const market = toMarket(fromTail, code);
  return { code, market };
}

let listCache: { at: number; items: ListItem[] } | null = null;
const quoteCache = new Map<string, { at: number; snap: MarketSnapshot }>();

async function stockList(): Promise<ListItem[]> {
  if (listCache && Date.now() - listCache.at < LIST_TTL_MS) return listCache.items;
  const json = await biyingGet(
    `https://api.biyingapi.com/hslt/list/${licence()}`
  );
  if (!Array.isArray(json)) throw new Error("必盈股票列表为空");
  const items: ListItem[] = [];
  for (const row of json) {
    if (!row || typeof row !== "object") continue;
    const r = row as ListItem;
    const parsed = parseListed(String(r.dm ?? ""), String(r.jys ?? ""));
    if (!parsed) continue;
    if (parsed.market === "bj") continue;
    items.push({ dm: parsed.code, mc: String(r.mc ?? ""), jys: parsed.market });
  }
  if (items.length === 0) throw new Error("必盈股票列表为空");
  listCache = { at: Date.now(), items };
  return items;
}

function snapshotFrom(item: ListItem, q: Realtime): MarketSnapshot {
  const code = item.dm;
  return {
    market: toMarket(item.jys, code),
    code,
    name: item.mc,
    price: num(q.p),
    volume: num(q.v),
    changePct: num(q.pc),
    amount: num(q.cje),
    turnover: numOrNull(q.hs),
    pe: numOrNull(q.pe),
    volumeRatio: numOrNull(q.lb),
    marketCap: num(q.sz),
    pb: numOrNull(q.sjl),
    listDate: null,
    prevClose: numOrNull(q.yc),
    change60Pct: numOrNull(q.zdf60),
    industry: null,
    peTtm: null,
  };
}

async function quoteOf(item: ListItem): Promise<MarketSnapshot> {
  const hit = quoteCache.get(item.dm);
  if (hit && Date.now() - hit.at < QUOTE_TTL_MS) return hit.snap;
  const json = (await biyingGet(
    `https://api.biyingapi.com/hsrl/ssjy/${item.dm}/${licence()}`
  )) as Realtime;
  const snap = snapshotFrom(item, json ?? {});
  quoteCache.set(item.dm, { at: Date.now(), snap });
  return snap;
}

function parseBars(json: unknown): KlineBar[] {
  const rows = Array.isArray(json) ? json : json ? [json] : [];
  return rows.map((row) => {
    const b = row as RawBar;
    return {
      date: String(b.t ?? ""),
      open: num(b.o),
      close: num(b.c),
      high: num(b.h),
      low: num(b.l),
      volume: num(b.v),
      amount: num(b.a),
    };
  });
}

function dayKey(date: string): string {
  return date.slice(0, 10);
}

/** 最新接口的 lt 只允许 1–5。更长的序列走历史接口，再补上最新几根。 */
async function latestBars(
  symbol: string,
  level: "d" | "5",
  adjust: "f" | "n" | null,
  lmt: number
): Promise<KlineBar[]> {
  const n = Math.min(Math.max(lmt, 1), 5);
  const tail = adjust
    ? `${symbol}/${level}/${adjust}/${licence()}?lt=${n}`
    : `${symbol}/${level}/${licence()}?lt=${n}`;
  const host = adjust
    ? `https://api.biyingapi.com/hsstock/latest/${tail}`
    : `https://api.biyingapi.com/hsindex/latest/${tail}`;
  return parseBars(await biyingGet(host));
}

async function historyBars(
  symbol: string,
  level: "d" | "5",
  adjust: "f" | "n" | null,
  lmt: number
): Promise<KlineBar[]> {
  const tail = adjust
    ? `${symbol}/${level}/${adjust}/${licence()}?lt=${lmt}`
    : `${symbol}/${level}/${licence()}?lt=${lmt}`;
  const host = adjust
    ? `https://all.biyingapi.com/hsstock/history/${tail}`
    : `https://api.biyingapi.com/hsindex/history/${tail}`;
  return parseBars(await biyingGet(host));
}

async function loadBars(
  symbol: string,
  level: "d" | "5",
  adjust: "f" | "n" | null,
  lmt: number
) {
  if (lmt <= 5) return latestBars(symbol, level, adjust, lmt);
  const hist = await historyBars(symbol, level, adjust, lmt);
  const fresh = await latestBars(symbol, level, adjust, 5);
  const key = (b: KlineBar) => (level === "d" ? dayKey(b.date) : b.date);
  const seen = new Set(hist.map(key));
  const extra = fresh.filter((b) => !seen.has(key(b)));
  return hist.concat(extra).slice(-lmt);
}

function toQuote(snap: MarketSnapshot, q: Realtime): QuoteLite {
  return {
    market: snap.market,
    code: snap.code,
    name: snap.name,
    price: snap.price,
    changePct: snap.changePct,
    volumeRatio: num(q.lb),
    turnover: snap.turnover,
    amount: snap.amount,
    open: num(q.o),
    high: num(q.h),
    low: num(q.l),
    prevClose: snap.prevClose,
  };
}

export const biyingMarketData: MarketData = {
  async fetchSnapshotPage(page, pageSize = 100) {
    const list = await stockList();
    const start = (page - 1) * pageSize;
    const slice = list.slice(start, start + pageSize);
    const items: MarketSnapshot[] = [];
    for (const item of slice) {
      items.push(await quoteOf(item));
    }
    return { items, total: list.length };
  },

  async fetchDailyKlines(market, code, lmt = 5) {
    return loadBars(`${code}.${suffix(market)}`, "d", "f", lmt);
  },

  async fetchIntraday5m(market, code, now = new Date()) {
    const bars = await loadBars(`${code}.${suffix(market)}`, "5", "n", 100);
    const ymd = shanghaiYmd(now);
    return bars.filter(
      (b) => b.date.startsWith(ymd) || b.date.startsWith(ymd.replace(/-/g, ""))
    );
  },

  async fetchIndexContext(now = new Date()) {
    const ymd = shanghaiYmd(now);
    const [bars5, daily5] = await Promise.all([
      loadBars("000001.SH", "5", null, 100),
      loadBars("000001.SH", "d", null, 120),
    ]);
    const intraday5m = bars5.filter(
      (b) => b.date.startsWith(ymd) || b.date.startsWith(ymd.replace(/-/g, ""))
    );
    return { intraday5m, daily5 };
  },

  async isShanghaiTradingDay(now = new Date()) {
    const bars = await latestBars("000001.SH", "d", null, 1);
    if (bars.length === 0) return false;
    const ymd = shanghaiYmd(now);
    const d = bars[bars.length - 1].date;
    return (
      d.startsWith(ymd) || d.replace(/-/g, "").startsWith(ymd.replace(/-/g, ""))
    );
  },

  async fetchQuotes(items) {
    if (items.length === 0) return [];
    const list = await stockList();
    const byCode = new Map(list.map((i) => [i.dm, i]));
    const out: QuoteLite[] = [];
    for (const item of items) {
      const listed = byCode.get(item.code) ?? {
        dm: item.code,
        mc: "",
        jys: item.market,
      };
      const json = (await biyingGet(
        `https://api.biyingapi.com/hsrl/ssjy/${item.code}/${licence()}`
      )) as Realtime;
      const snap = snapshotFrom(listed, json ?? {});
      quoteCache.set(item.code, { at: Date.now(), snap });
      out.push(toQuote(snap, json ?? {}));
    }
    return out;
  },

  async resolveStock(code) {
    const market = codeToMarket(code);
    const list = await stockList();
    const listed = list.find((i) => i.dm === code);
    if (!listed) throw new Error(`找不到股票: ${code}`);
    const snap = await quoteOf(listed);
    return {
      market: snap.market || market,
      code: snap.code,
      name: snap.name,
      price: snap.price,
    };
  },
};
