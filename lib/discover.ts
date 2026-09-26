import {
  getMarketData,
  type KlineBar,
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

export type DiscoverProgress = {
  phase: "scan" | "commit";
  snapshotSource: "biying" | null;
  snapshotPage: number;
  snapshotPages: number;
  pageCursor: number;
  scored: number;
  skipped: number;
  failedCodes: string[];
  suggestions: Suggestion[];
  indexBars: KlineBar[] | null;
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

const MAX_SCORE_PER_STEP = 30;
const MAX_SCAN_PER_STEP = 120;

export function discoverBarCounts(progress: {
  scored?: number;
  skipped?: number;
  snapshotSource?: string | null;
  snapshotPages?: number;
}): { processed: number; total: number } {
  const processed = (progress.scored ?? 0) + (progress.skipped ?? 0);
  const pages = progress.snapshotPages ?? 0;
  const total =
    progress.snapshotSource === "biying" && pages > 0
      ? pages * 100
      : processed + MAX_SCORE_PER_STEP;
  return { processed, total: Math.max(total, processed) };
}

function emptyProgress(): DiscoverProgress {
  return {
    phase: "scan",
    snapshotSource: null,
    snapshotPage: 1,
    snapshotPages: 0,
    pageCursor: 0,
    scored: 0,
    skipped: 0,
    failedCodes: [],
    suggestions: [],
    indexBars: null,
  };
}

function asProgress(raw: unknown): DiscoverProgress {
  if (!raw || typeof raw !== "object") return emptyProgress();
  return { ...emptyProgress(), ...(raw as DiscoverProgress) };
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

async function loadPage(
  progress: DiscoverProgress
): Promise<{ items: MarketSnapshot[]; done: boolean }> {
  const data = getMarketData();
  if (!progress.snapshotSource) {
    const first = await data.fetchSnapshotPage(1, 100);
    progress.snapshotSource = "biying";
    progress.snapshotPages = Math.max(1, Math.ceil(first.total / 100));
    progress.snapshotPage = 1;
    progress.pageCursor = 0;
    console.log(
      `[discover] biying pages=${progress.snapshotPages} total=${first.total}`
    );
    return { items: first.items, done: false };
  }

  if (progress.snapshotPage > progress.snapshotPages) {
    return { items: [], done: true };
  }
  const page = await data.fetchSnapshotPage(progress.snapshotPage, 100);
  return { items: page.items, done: false };
}

function asAlign(value: unknown): PoolAlign {
  if (value === "bull" || value === "bear" || value === "mixed") return value;
  return "mixed";
}

async function syncWatchPool(
  runId: number,
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

  const trends: { id: number; maAlign: PoolAlign }[] = [];
  for (const row of poolRows ?? []) {
    try {
      const bars = await getMarketData().fetchDailyKlines(
        row.market as Market,
        row.code as string,
        120
      );
      if (bars.length === 0) continue;
      trends.push({
        id: row.id as number,
        maAlign: deriveDailyFeatures(bars).maAlign,
      });
    } catch {
      continue;
    }
  }

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

  const progress = asProgress(run.progress);
  const events: StepEvent[] = [];
  if (!progress.indexBars) {
    try {
      progress.indexBars = await getMarketData().fetchDailyKlines("sh", "000001", 120);
    } catch {
      progress.indexBars = [];
    }
  }
  let scoredThisStep = 0;
  let scannedThisStep = 0;

  while (scoredThisStep < MAX_SCORE_PER_STEP && scannedThisStep < MAX_SCAN_PER_STEP) {
    const { items, done } = await loadPage(progress);
    if (done || items.length === 0) {
      progress.phase = "commit";
      break;
    }

    while (
      progress.pageCursor < items.length &&
      scoredThisStep < MAX_SCORE_PER_STEP &&
      scannedThisStep < MAX_SCAN_PER_STEP
    ) {
      const snap = items[progress.pageCursor];
      progress.pageCursor += 1;
      scannedThisStep += 1;
      const gate = shouldScore(snap);
      if (!gate.ok) {
        progress.skipped += 1;
        events.push({
          level: "info",
          text: `${snap.code} ${snap.name} 跳过：${gate.reason}`,
        });
        continue;
      }
      const ev = await scoreOne(run.id as number, snap, progress.indexBars);
      events.push(ev);
      if (ev.level === "ok") {
        progress.scored += 1;
        scoredThisStep += 1;
      } else if (ev.level === "fail") {
        progress.failedCodes.push(snap.code);
        scoredThisStep += 1;
      } else {
        // 近5日均额不足等：已拉日K，计入跳过与本步配额
        progress.skipped += 1;
        scoredThisStep += 1;
      }
    }

    if (progress.pageCursor >= items.length) {
      progress.snapshotPage += 1;
      progress.pageCursor = 0;
      if (
        progress.snapshotSource === "biying" &&
        progress.snapshotPage > progress.snapshotPages
      ) {
        progress.phase = "commit";
        break;
      }
    }

    if (scoredThisStep >= MAX_SCORE_PER_STEP) break;
  }

  if (progress.phase === "commit") {
    const { data: rows, error } = await sb
      .from("judgments")
      .select("market,code,probability,details,prompt")
      .eq("run_id", run.id)
      .eq("kind", "score")
      .order("probability", { ascending: false })
      .limit(10);
    if (error) throw error;

    const synced = await syncWatchPool(
      run.id as number,
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
    await completeRun(run.id as number, progress);
    console.log(
      `[discover] done scored=${progress.scored} suggestions=${suggestions.length} removed=${synced.removed} inserted=${synced.inserted}`
    );
    const scanned = progress.scored + progress.skipped;
    return {
      done: true,
      processed: scanned,
      total: scanned,
      runId: run.id as number,
      phase: "commit",
      message: `发现完成，移出 ${synced.removed}，补入 ${synced.inserted}`,
      events: [
        ...events,
        {
          level: "info",
          text: `发现完成，打分 ${progress.scored}，跳过 ${progress.skipped}，移出 ${synced.removed}，补入 ${synced.inserted}`,
        },
        ...suggestions.map((s, i) => ({
          level: "ok" as const,
          text: `${i + 1}. ${s.code} ${s.name}  ${s.score}`,
        })),
      ],
      suggestions,
    };
  }

  await saveProgress(run.id as number, progress);
  const bar = discoverBarCounts(progress);
  const message = `打分 ${progress.scored} · 跳过 ${progress.skipped} · 页 ${progress.snapshotPage}`;
  console.log(`[discover] step ${message}`);
  return {
    done: false,
    processed: bar.processed,
    total: bar.total,
    runId: run.id as number,
    phase: "scan",
    message,
    events,
  };
}
