import type { Market } from "@/lib/market";
import { biyingMarketData } from "@/lib/biying";

export type MarketSnapshot = {
  market: Market;
  code: string;
  name: string;
  price: number;
  volume: number;
  changePct: number;
  amount: number;
  turnover: number | null;
  pe: number | null;
  volumeRatio: number | null;
  marketCap: number;
  pb: number | null;
  listDate: number | null;
  prevClose: number | null;
  change60Pct: number | null;
  industry: string | null;
  peTtm: number | null;
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
  turnover: number | null;
  amount: number;
  open: number;
  high: number;
  low: number;
  prevClose: number | null;
};

export type SnapshotPage = {
  items: MarketSnapshot[];
  total: number;
};

export type ListedStock = {
  market: Market;
  code: string;
  name: string;
};

export type ListedSlice = {
  items: ListedStock[];
  total: number;
};

export type IndexContext = {
  intraday5m: KlineBar[];
  daily5: KlineBar[];
};

export type ResolvedStock = {
  market: Market;
  code: string;
  name: string;
  price: number;
};

/** 行情端口。换数据源只换 getMarketData 的返回值。 */
export type MarketData = {
  fetchListedSlice(offset: number, limit: number): Promise<ListedSlice>;
  fetchOneSnapshot(item: ListedStock): Promise<MarketSnapshot>;
  fetchSnapshotSlice(offset: number, limit: number): Promise<SnapshotPage>;
  fetchSnapshotPage(page: number, pageSize?: number): Promise<SnapshotPage>;
  fetchDailyKlines(market: Market, code: string, lmt?: number): Promise<KlineBar[]>;
  fetchIntraday5m(market: Market, code: string, now?: Date): Promise<KlineBar[]>;
  fetchIndexContext(now?: Date): Promise<IndexContext>;
  isShanghaiTradingDay(now?: Date): Promise<boolean>;
  fetchQuotes(items: { market: Market; code: string }[]): Promise<QuoteLite[]>;
  resolveStock(code: string): Promise<ResolvedStock>;
};

export function getMarketData(): MarketData {
  return biyingMarketData;
}
