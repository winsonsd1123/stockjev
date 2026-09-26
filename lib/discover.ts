import {
  getMarketData,
  type KlineBar,
  type ListedStock,
  type MarketSnapshot,
} from "@/lib/market-data";
import {
  bucketCap,
  bucketPb,
  bucketPe,
  deriveDailyFeatures,
  passesLiquidity5d,
  shouldScore,
} from "@/lib/filter";
import { buildExcellenceQuestion, parseNouls, parseScore } from "@/lib/jev";
import { decide, jevRequest } from "@/lib/jev-client";
import { limitPct, type Market } from "@/lib/market";
import { discoverCap, reconcilePool, type PoolAlign } from "@/lib/rules";
import { getSupabase } from "@/lib/supabase";

export type Suggestion = {
  market: Market;
  code: string;
  name: string;
  score: number;
  status?: string;
};

export type PoolTrend = { id: number; maAlign: PoolAlign };

export type DiscoverPhase = "snapshot" | "score" | "commit";

export type DiscoverProgress = {
  phase: DiscoverPhase;
  snapshotSource: "biying" | null;
  snapshotPage: number;
  snapshotPages: number;
  pageCursor: number;
  listCursor: number;
  listTotal: number;
  seen: number;
  batch: MarketSnapshot[];
  scored: number;
  skipped: number;
  failedCodes: string[];
  suggestions: Suggestion[];
  indexBars: KlineBar[] | null;
  poolTrends: PoolTrend[];
  poolTrendDone: number[];
};

export type StepEvent = {
  level: "info" | "ok" | "fail";
  text: string;
};

export type StepResult = {
  done: boolean;
  processed: number;
  total: number;
  runId: number;
  phase: string;
  message: string;
  events: StepEvent[];
  suggestions?: Suggestion[];
};

const QUOTE_WAVE = 6;
const SCORE_WAVE = 3;
const LAUNCH_BUDGET_MS = 35_000;
export const LEGACY_PAGE_SIZE = 100;

export function legacyListCursor(input: {
  snapshotSource?: string | null;
  snapshotPage?: number;
  pageCursor?: number;
}): number {
  if (!input.snapshotSource) return 0;
  const page = input.snapshotPage ?? 1;
  const cursor = input.pageCursor ?? 0;
  return Math.max(0, (page - 1) * LEGACY_PAGE_SIZE + cursor);
}

export function discoverBarCounts(progress: {
  seen?: number;
  listTotal?: number;
  snapshotSource?: string | null;
  snapshotPage?: number;
  snapshotPages?: number;
  pageCursor?: number;
  batch?: unknown;
}): { processed: number; total: number } {
  const legacy = !Array.isArray(progress.batch) && progress.seen == null;
  const seen = legacy ? legacyListCursor(progress) : (progress.seen ?? 0);
  let total = progress.listTotal ?? 0;
  if (total <= 0 && legacy && (progress.snapshotPages ?? 0) > 0) {
    total = (progress.snapshotPages ?? 0) * LEGACY_PAGE_SIZE;
  }
  if (total > 0) return { processed: Math.min(seen, total), total };
  return { processed: seen, total: 0 };
}

export function discoverProgressMessage(progress: {
  seen?: number;
  listTotal?: number;
  pending?: number;
  batch?: unknown;
  scored?: number;
  skipped?: number;
}): string {
  const seen = progress.seen ?? 0;
  const total = progress.listTotal && progress.listTotal > 0 ? progress.listTotal : "—";
  const pending = Array.isArray(progress.batch)
    ? progress.batch.length
    : (progress.pending ?? 0);
  return `已扫 ${seen}/${total} · 待打分 ${pending} · 累计打分 ${progress.scored ?? 0} · 跳过 ${progress.skipped ?? 0}`;
}

function emptyProgress(): DiscoverProgress {
  return {
    phase: "snapshot",
    snapshotSource: null,
    snapshotPage: 1,
    snapshotPages: 0,
    pageCursor: 0,
    listCursor: 0,
    listTotal: 0,
    seen: 0,
    batch: [],
    scored: 0,
    skipped: 0,
    failedCodes: [],
    suggestions: [],
    indexBars: null,
    poolTrends: [],
    poolTrendDone: [],
  };
}

function asPhase(value: unknown): DiscoverPhase {
  if (value === "score" || value === "commit" || value === "snapshot") return value;
  return "snapshot";
}

function asProgress(raw: unknown): DiscoverProgress {
  const base = emptyProgress();
  if (!raw || typeof raw !== "object") return base;
  const src = raw as Record<string, unknown>;
  const hasBatch = Array.isArray(src.batch);
  const progress: DiscoverProgress = {
    ...base,
    phase: asPhase(src.phase),
    snapshotSource: src.snapshotSource === "biying" ? "biying" : null,
    snapshotPage: numField(src.snapshotPage, base.snapshotPage),
    snapshotPages: numField(src.snapshotPages, 0),
    pageCursor: numField(src.pageCursor, 0),
    listCursor: numField(src.listCursor, 0),
    listTotal: numField(src.listTotal, 0),
    seen: numField(src.seen, 0),
    batch: hasBatch ? (src.batch as MarketSnapshot[]) : [],
    scored: numField(src.scored, 0),
    skipped: numField(src.skipped, 0),
    failedCodes: Array.isArray(src.failedCodes)
      ? src.failedCodes.filter((c): c is string => typeof c === "string")
      : [],
    suggestions: Array.isArray(src.suggestions)
      ? (src.suggestions as Suggestion[])
      : [],
    indexBars: Array.isArray(src.indexBars) ? (src.indexBars as KlineBar[]) : null,
    poolTrends: Array.isArray(src.poolTrends) ? (src.poolTrends as PoolTrend[]) : [],
    poolTrendDone: Array.isArray(src.poolTrendDone)
      ? src.poolTrendDone.filter((id): id is number => typeof id === "number")
      : [],
  };
  if (!hasBatch && progress.seen === 0 && progress.listCursor === 0) {
    progress.listCursor = legacyListCursor(progress);
    progress.seen = progress.listCursor;
    if (progress.listTotal <= 0 && progress.snapshotPages > 0) {
      progress.listTotal = progress.snapshotPages * LEGACY_PAGE_SIZE;
    }
  }
  return progress;
}

function numField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export async function getRunningRun(type: "discover" | "poll") {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("runs")
    .select("*")
    .eq("status", "running")
    .eq("type", type)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function anyRunningRun() {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("runs")
    .select("*")
    .eq("status", "running")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function startDiscoverRun(): Promise<{ runId: number }> {
  const existing = await anyRunningRun();
  if (existing) {
    const err = new Error("已有任务在运行") as Error & { status: number };
    err.status = 409;
    throw err;
  }
  const sb = getSupabase();
  const { data, error } = await sb
    .from("runs")
    .insert({
      type: "discover",
      status: "running",
      progress: emptyProgress(),
    })
    .select("*")
    .single();
  if (error) throw error;
  console.log(`[discover] start run=${data.id}`);
  return { runId: data.id as number };
}

async function saveProgress(runId: number, progress: DiscoverProgress) {
  const sb = getSupabase();
  const { error } = await sb
    .from("runs")
    .update({ progress })
    .eq("id", runId);
  if (error) throw error;
}

async function completeRun(runId: number, progress: DiscoverProgress) {
  const sb = getSupabase();
  const { error } = await sb
    .from("runs")
    .update({
      status: "completed",
      finished_at: new Date().toISOString(),
      progress,
    })
    .eq("id", runId);
  if (error) throw error;
}

function roundNum(n: number | null): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 10000) / 10000;
}

async function scoreOne(
  runId: number,
  snap: MarketSnapshot,
  indexBars: KlineBar[] | null
): Promise<StepEvent> {
  const sb = getSupabase();
  const gate = shouldScore(snap);
  if (!gate.ok) {
    console.log(`[discover] skip ${snap.code} ${snap.name} ${gate.reason}`);
    return {
      level: "info",
      text: `${snap.code} ${snap.name} 跳过：${gate.reason}`,
    };
  }

  try {
    const klines = await getMarketData().fetchDailyKlines(snap.market, snap.code, 120);
    if (klines.length === 0) {
      console.log(`[discover] fail ${snap.code} 无日K`);
      return { level: "fail", text: `${snap.code} ${snap.name} 无日K，跳过` };
    }
    const liq = passesLiquidity5d(klines);
    if (!liq.ok) {
      console.log(
        `[discover] skip ${snap.code} ${snap.name} ${liq.reason} avg=${Math.round(liq.avgAmount)}`
      );
      return {
        level: "info",
        text: `${snap.code} ${snap.name} 跳过：${liq.reason}`,
      };
    }
    const rawFeatures = deriveDailyFeatures(klines, {
      limitPct: limitPct(snap.market, snap.code),
      indexBars: indexBars ?? undefined,
    });
    const features = Object.fromEntries(
      Object.entries(rawFeatures).map(([k, v]) => [
        k,
        typeof v === "number" ? roundNum(v) : v,
      ])
    );
    const state = {
      snapshot: {
        name: snap.name,
        market: snap.market,
        code: snap.code,
        industry: snap.industry,
        peBucket: bucketPe(snap.peTtm ?? snap.pe),
        pbBucket: bucketPb(snap.pb),
        capBucket: bucketCap(snap.marketCap),
        turnover: snap.turnover,
        volumeRatio: snap.volumeRatio,
        change60Pct: snap.change60Pct,
      },
      features,
    };
    const questions = buildExcellenceQuestion();
    const prompt = jevRequest(state, questions);
    const resp = await decide(state, questions);
    const parsed = parseScore(resp, "excellence");
    const parts = parseNouls(resp, ["overextended", "trendHealthy"]);
    const cap = discoverCap(rawFeatures);
    const capped =
      cap.cap == null
        ? parsed.probability
        : Math.min(parsed.probability, cap.cap / 100);
    const rank = Math.min(capped, parsed.probability * (1 - parts.overextended));
    const display = Math.round(rank * 100);
    await sb.from("judgments").insert({
      run_id: runId,
      market: snap.market,
      code: snap.code,
      kind: "score",
      probability: rank,
      prompt,
      details: {
        ...parsed.details,
        name: snap.name,
        features,
        overextended: parts.overextended,
        trendHealthy: parts.trendHealthy,
        cap: cap.cap,
        tag: cap.tag,
        rawDisplayScore: parsed.displayScore,
        displayScore: display,
      },
    });
    console.log(
      `[discover] score ${snap.code} ${snap.name} raw=${parsed.displayScore} rank=${display}`
    );
    return {
      level: "ok",
      text: `${snap.code} ${snap.name}  AI分 ${display}${cap.tag ? `（${cap.tag}）` : ""}`,
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : "未知错误";
    console.log(`[discover] fail ${snap.code} ${reason}`);
    return {
      level: "fail",
      text: `${snap.code} ${snap.name} 失败：${reason}`,
    };
  }
}

function asAlign(value: unknown): PoolAlign {
  if (value === "bull" || value === "bear" || value === "mixed") return value;
  return "mixed";
}

async function syncWatchPool(
  runId: number,
  trends: PoolTrend[],
  rows: {
    market: string;
    code: string;
    probability: number;
    details: unknown;
    prompt: unknown;
  }[]
): Promise<{ suggestions: Suggestion[]; removed: number; inserted: number }> {
  const sb = getSupabase();
  const gated = rows.map((r) => {
    const details = (r.details ?? {}) as {
      name?: string;
      features?: {
        maAlign?: unknown;
        ret20?: number | null;
        pos20?: number | null;
        limitUpCount20?: number;
        bias20?: number | null;
      };
    };
    const features = details.features;
    const cap = discoverCap({
      ret20: features?.ret20 ?? null,
      pos20: features?.pos20 ?? null,
      limitUpCount20: features?.limitUpCount20 ?? 0,
      bias20: features?.bias20 ?? null,
    });
    return {
      market: r.market,
      code: r.code,
      name: String(details.name ?? r.code),
      score: Math.round(Number(r.probability) * 100),
      maAlign: asAlign(features?.maAlign),
      capped: cap.cap != null,
    };
  });

  const { data: poolRows, error: poolError } = await sb
    .from("watchlist")
    .select("id,market,code,starred,bear_streak,score,confidence");
  if (poolError) throw poolError;

  const { data: prevRun } = await sb
    .from("runs")
    .select("progress")
    .eq("type", "discover")
    .eq("status", "completed")
    .neq("id", runId)
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const prevSuggestions =
    (prevRun?.progress as { suggestions?: { market?: string; code?: string }[] } | null)
      ?.suggestions ?? [];
  const previousCodes = prevSuggestions
    .filter((s) => s.market && s.code)
    .map((s) => `${s.market}:${s.code}`);

  const promptByKey = new Map(
    rows.map((r) => [`${r.market}:${r.code}`, r.prompt ?? null])
  );
  const poolById = new Map((poolRows ?? []).map((row) => [row.id as number, row]));

  const plan = reconcilePool({
    pool: (poolRows ?? []).map((row) => ({
      id: row.id as number,
      market: row.market as string,
      code: row.code as string,
      starred: Boolean(row.starred),
      bearStreak: Number(row.bear_streak ?? 0),
      score: row.score == null ? null : Number(row.score),
    })),
    trends,
    suggestions: gated,
    previousCodes,
  });

  if (plan.removeIds.length > 0) {
    const { error } = await sb.from("watchlist").delete().in("id", plan.removeIds);
    if (error) throw error;
  }
  for (const update of plan.trendUpdates) {
    const { error } = await sb
      .from("watchlist")
      .update({ bear_streak: update.bearStreak, trend_tag: update.trendTag })
      .eq("id", update.id);
    if (error) throw error;
  }
  for (const update of plan.scoreUpdates) {
    const pool = poolById.get(update.id);
    const prompt = pool
      ? (promptByKey.get(`${pool.market}:${pool.code}`) ?? null)
      : null;
    const { error } = await sb
      .from("watchlist")
      .update({
        score: update.score,
        prompt,
        confidence: Number(pool?.confidence ?? 0) + 1,
      })
      .eq("id", update.id);
    if (error) throw error;
  }
  for (const row of plan.inserts) {
    const stock = await getMarketData().resolveStock(row.code);
    const { error } = await sb.from("watchlist").insert({
      market: row.market,
      code: row.code,
      name: row.name,
      source: "ai",
      starred: false,
      score: row.score,
      entry_price: stock.price > 0 ? stock.price : null,
      prompt: promptByKey.get(`${row.market}:${row.code}`) ?? null,
      confidence: 1,
    });
    if (error) throw error;
  }

  const statusByKey = new Map(
    plan.statuses.map((s) => [`${s.market}:${s.code}`, s.status])
  );
  const suggestions: Suggestion[] = gated.map((s) => ({
    market: s.market as Market,
    code: s.code,
    name: s.name,
    score: s.score,
    status: statusByKey.get(`${s.market}:${s.code}`),
  }));
  return {
    suggestions,
    removed: plan.removeIds.length,
    inserted: plan.inserts.length,
  };
}

export async function stepDiscover(runId?: number): Promise<StepResult> {
  const sb = getSupabase();
  let run;
  if (runId != null) {
    const { data, error } = await sb
      .from("runs")
      .select("*")
      .eq("id", runId)
      .single();
    if (error) throw error;
    run = data;
  } else {
    run = await getRunningRun("discover");
  }
  if (!run || run.status !== "running") {
    throw new Error("没有进行中的 discover 任务");
  }

  const until = Date.now() + LAUNCH_BUDGET_MS;
  const progress = asProgress(run.progress);
  const events: StepEvent[] = [];
  const ran = progress.phase;
  const activeId = run.id as number;
  const persist = () => saveProgress(activeId, progress);

  if (ran === "commit") {
    const ready = await pullPoolTrends(progress, until);
    if (!ready) {
      await persist();
      const message = `正在读取观察池趋势 ${progress.poolTrendDone.length} 只`;
      console.log(`[discover] step ${message}`);
      return openResult(activeId, progress, "commit", message, events);
    }
    await persist();
    return finishCommit(activeId, progress, events);
  }

  if (ran === "score") {
    await runScore(activeId, progress, events, until, persist);
    if (progress.batch.length === 0 && !expired(until)) {
      await runSnapshot(progress, events, until, persist);
    }
  } else {
    await runSnapshot(progress, events, until, persist);
    if (progress.batch.length > 0 && !expired(until)) {
      await runScore(activeId, progress, events, until, persist);
    }
  }

  settlePhase(progress);
  await persist();
  const message = discoverProgressMessage(progress);
  console.log(`[discover] step ${message}`);
  return openResult(activeId, progress, progress.phase, message, events);
}

function listFinished(progress: DiscoverProgress): boolean {
  return progress.snapshotSource != null && progress.listCursor >= progress.listTotal;
}

function expired(until: number): boolean {
  return Date.now() >= until;
}

function isStName(name: string): boolean {
  return /ST/i.test(name);
}

function settlePhase(progress: DiscoverProgress) {
  if (progress.batch.length > 0) progress.phase = "score";
  else if (listFinished(progress)) progress.phase = "commit";
  else progress.phase = "snapshot";
}

function openResult(
  runId: number,
  progress: DiscoverProgress,
  phase: DiscoverPhase,
  message: string,
  events: StepEvent[],
  done = false,
  suggestions?: Suggestion[]
): StepResult {
  const bar = discoverBarCounts(progress);
  return {
    done,
    processed: bar.processed,
    total: bar.total > 0 ? bar.total : bar.processed,
    runId,
    phase,
    message,
    events,
    suggestions,
  };
}

async function ensureIndex(progress: DiscoverProgress, until: number) {
  if (progress.indexBars || expired(until)) return;
  try {
    progress.indexBars = await getMarketData().fetchDailyKlines("sh", "000001", 120);
  } catch {
    progress.indexBars = [];
  }
}

async function hasScore(runId: number, market: string, code: string): Promise<boolean> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("judgments")
    .select("id")
    .eq("run_id", runId)
    .eq("market", market)
    .eq("code", code)
    .eq("kind", "score")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data != null;
}

async function ensureList(progress: DiscoverProgress) {
  if (progress.snapshotSource && progress.listTotal > 0) return;
  const page = await getMarketData().fetchListedSlice(0, 1);
  progress.snapshotSource = "biying";
  progress.listTotal = page.total;
  progress.snapshotPages = page.total === 0 ? 0 : Math.ceil(page.total / LEGACY_PAGE_SIZE);
  console.log(`[discover] biying total=${page.total} cursor=${progress.listCursor}`);
}

async function takeQuoteWave(progress: DiscoverProgress): Promise<{
  wave: ListedStock[];
  stCount: number;
}> {
  const wave: ListedStock[] = [];
  let stCount = 0;
  while (wave.length < QUOTE_WAVE && progress.listCursor < progress.listTotal) {
    const page = await getMarketData().fetchListedSlice(progress.listCursor, 1);
    progress.listTotal = page.total;
    if (page.items.length === 0) {
      progress.listCursor = page.total;
      break;
    }
    const item = page.items[0];
    progress.listCursor += 1;
    progress.seen += 1;
    if (isStName(item.name)) {
      progress.skipped += 1;
      stCount += 1;
      continue;
    }
    wave.push(item);
  }
  return { wave, stCount };
}

async function runSnapshot(
  progress: DiscoverProgress,
  events: StepEvent[],
  until: number,
  persist: () => Promise<void>
) {
  await ensureIndex(progress, until);
  await ensureList(progress);
  if (listFinished(progress)) return;
  while (!expired(until) && !listFinished(progress)) {
    const { wave, stCount } = await takeQuoteWave(progress);
    if (stCount > 0) {
      events.push({ level: "info", text: `跳过 ST ${stCount} 只` });
    }
    if (wave.length === 0) break;
    const snaps = await Promise.all(
      wave.map(async (item) => {
        try {
          return { item, snap: await getMarketData().fetchOneSnapshot(item) };
        } catch (e) {
          const reason = e instanceof Error ? e.message : "行情失败";
          return { item, reason };
        }
      })
    );
    for (const row of snaps) {
      if ("reason" in row && row.reason) {
        progress.failedCodes.push(row.item.code);
        events.push({
          level: "fail",
          text: `${row.item.code} ${row.item.name} 失败：${row.reason}`,
        });
        console.log(`[discover] fail ${row.item.code} ${row.reason}`);
        continue;
      }
      const snap = row.snap;
      if (!snap) continue;
      const gate = shouldScore(snap);
      if (!gate.ok) {
        progress.skipped += 1;
        events.push({
          level: "info",
          text: `${snap.code} ${snap.name} 跳过：${gate.reason}`,
        });
        console.log(`[discover] skip ${snap.code} ${snap.name} ${gate.reason}`);
        continue;
      }
      progress.batch.push(snap);
    }
    settlePhase(progress);
    await persist();
  }
}

async function scoreWaveItem(
  runId: number,
  snap: MarketSnapshot,
  indexBars: KlineBar[] | null
): Promise<{ snap: MarketSnapshot; ev: StepEvent; kind: "dup" | "ok" | "fail" | "skip" }> {
  if (await hasScore(runId, snap.market, snap.code)) {
    return {
      snap,
      kind: "dup",
      ev: { level: "info", text: `${snap.code} ${snap.name} 已有打分，跳过` },
    };
  }
  const ev = await scoreOne(runId, snap, indexBars);
  if (ev.level === "ok") return { snap, ev, kind: "ok" };
  if (ev.level === "fail") return { snap, ev, kind: "fail" };
  return { snap, ev, kind: "skip" };
}

async function runScore(
  runId: number,
  progress: DiscoverProgress,
  events: StepEvent[],
  until: number,
  persist: () => Promise<void>
) {
  await ensureIndex(progress, until);
  while (progress.batch.length > 0 && !expired(until)) {
    const wave = progress.batch.slice(0, SCORE_WAVE);
    const results = await Promise.all(
      wave.map((snap) => scoreWaveItem(runId, snap, progress.indexBars))
    );
    progress.batch.splice(0, results.length);
    for (const row of results) {
      events.push(row.ev);
      if (row.kind === "ok") progress.scored += 1;
      else if (row.kind === "fail") progress.failedCodes.push(row.snap.code);
      else if (row.kind === "skip") progress.skipped += 1;
    }
    settlePhase(progress);
    await persist();
  }
}

async function pullPoolTrends(progress: DiscoverProgress, until: number): Promise<boolean> {
  const sb = getSupabase();
  const { data: poolRows, error } = await sb.from("watchlist").select("id,market,code");
  if (error) throw error;
  const done = new Set(progress.poolTrendDone);
  const trends = [...progress.poolTrends];
  for (const row of poolRows ?? []) {
    const id = row.id as number;
    if (done.has(id)) continue;
    if (expired(until)) {
      progress.poolTrends = trends;
      progress.poolTrendDone = [...done];
      return false;
    }
    try {
      const bars = await getMarketData().fetchDailyKlines(
        row.market as Market,
        row.code as string,
        120
      );
      if (bars.length > 0) {
        trends.push({
          id,
          maAlign: deriveDailyFeatures(bars).maAlign,
        });
      }
    } catch {
      /* 单只失败记为已尝试，下一步不再卡住 */
    }
    done.add(id);
  }
  progress.poolTrends = trends;
  progress.poolTrendDone = [...done];
  return true;
}

async function finishCommit(
  runId: number,
  progress: DiscoverProgress,
  events: StepEvent[]
): Promise<StepResult> {
  const sb = getSupabase();
  const { data: rows, error } = await sb
    .from("judgments")
    .select("market,code,probability,details,prompt")
    .eq("run_id", runId)
    .eq("kind", "score")
    .order("probability", { ascending: false })
    .limit(10);
  if (error) throw error;

  const synced = await syncWatchPool(
    runId,
    progress.poolTrends,
    (rows ?? []).map((r) => ({
      market: r.market as string,
      code: r.code as string,
      probability: Number(r.probability),
      details: r.details,
      prompt: r.prompt,
    }))
  );
  const suggestions = synced.suggestions;
  progress.suggestions = suggestions;
  progress.phase = "commit";
  await completeRun(runId, progress);
  console.log(
    `[discover] done scored=${progress.scored} suggestions=${suggestions.length} removed=${synced.removed} inserted=${synced.inserted}`
  );
  const doneEvents: StepEvent[] = [
    ...events,
    {
      level: "info",
      text: `发现完成，打分 ${progress.scored}，跳过 ${progress.skipped}，移出 ${synced.removed}，补入 ${synced.inserted}`,
    },
    ...suggestions.map((s, i) => ({
      level: "ok" as const,
      text: `${i + 1}. ${s.code} ${s.name}  ${s.score}`,
    })),
  ];
  return openResult(
    runId,
    progress,
    "commit",
    `发现完成，移出 ${synced.removed}，补入 ${synced.inserted}`,
    doneEvents,
    true,
    suggestions
  );
}
