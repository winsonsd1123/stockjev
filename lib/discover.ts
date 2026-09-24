import {
  fetchDailyKlines,
  fetchEastmoneyPage,
  fetchSinaPage,
  type MarketSnapshot,
} from "@/lib/eastmoney";
import { deriveDailyFeatures, passesLiquidity5d, shouldScore } from "@/lib/filter";
import { buildExcellenceQuestion, parseScore } from "@/lib/jev";
import { decide } from "@/lib/jev-client";
import type { Market } from "@/lib/market";
import { getSupabase } from "@/lib/supabase";

export type Suggestion = {
  market: Market;
  code: string;
  name: string;
  score: number;
};

export type DiscoverProgress = {
  phase: "scan" | "commit";
  snapshotSource: "eastmoney" | "sina" | null;
  snapshotPage: number;
  snapshotPages: number;
  sinaNode: "hs_a" | "hs_bjs";
  pageCursor: number;
  scored: number;
  skipped: number;
  failedCodes: string[];
  suggestions: Suggestion[];
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
    progress.snapshotSource === "eastmoney" && pages > 0
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
    sinaNode: "hs_a",
    pageCursor: 0,
    scored: 0,
    skipped: 0,
    failedCodes: [],
    suggestions: [],
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

async function scoreOne(
  runId: number,
  snap: MarketSnapshot
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
    const klines = await fetchDailyKlines(snap.market, snap.code, 20);
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
    const features = deriveDailyFeatures(klines);
    const state = {
      snapshot: {
        name: snap.name,
        market: snap.market,
        code: snap.code,
        marketCap: snap.marketCap,
        pe: snap.pe,
        pb: snap.pb,
        turnover: snap.turnover,
        volumeRatio: snap.volumeRatio,
        changePct: snap.changePct,
        amount: snap.amount,
      },
      dailyKlines: klines,
      features,
    };
    const resp = await decide(state, buildExcellenceQuestion());
    const parsed = parseScore(resp, "excellence");
    await sb.from("judgments").insert({
      run_id: runId,
      market: snap.market,
      code: snap.code,
      kind: "score",
      probability: parsed.probability,
      details: { ...parsed.details, name: snap.name },
    });
    console.log(
      `[discover] score ${snap.code} ${snap.name} ${parsed.displayScore}`
    );
    return {
      level: "ok",
      text: `${snap.code} ${snap.name}  AI分 ${parsed.displayScore}`,
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
  if (!progress.snapshotSource) {
    try {
      const first = await fetchEastmoneyPage(1, 100);
      progress.snapshotSource = "eastmoney";
      progress.snapshotPages = Math.max(1, Math.ceil(first.total / 100));
      progress.snapshotPage = 1;
      progress.pageCursor = 0;
      console.log(
        `[discover] eastmoney pages=${progress.snapshotPages} total=${first.total}`
      );
      return { items: first.items, done: false };
    } catch {
      progress.snapshotSource = "sina";
      progress.sinaNode = "hs_a";
      progress.snapshotPage = 1;
      progress.pageCursor = 0;
      console.log("[discover] eastmoney unavailable, use sina");
      const items = await fetchSinaPage("hs_a", 1);
      return { items, done: false };
    }
  }

  if (progress.snapshotSource === "eastmoney") {
    if (progress.snapshotPage > progress.snapshotPages) {
      return { items: [], done: true };
    }
    const page = await fetchEastmoneyPage(progress.snapshotPage, 100);
    return { items: page.items, done: false };
  }

  const items = await fetchSinaPage(progress.sinaNode, progress.snapshotPage);
  if (items.length === 0) {
    if (progress.sinaNode === "hs_a") {
      progress.sinaNode = "hs_bjs";
      progress.snapshotPage = 1;
      progress.pageCursor = 0;
      const bj = await fetchSinaPage("hs_bjs", 1);
      return { items: bj, done: false };
    }
    return { items: [], done: true };
  }
  return { items, done: false };
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
      const ev = await scoreOne(run.id as number, snap);
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
        progress.snapshotSource === "eastmoney" &&
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
      .select("market,code,probability,details")
      .eq("run_id", run.id)
      .eq("kind", "score")
      .order("probability", { ascending: false })
      .limit(10);
    if (error) throw error;

    const suggestions: Suggestion[] = (rows ?? []).map((r) => ({
      market: r.market as Market,
      code: r.code as string,
      name: String((r.details as { name?: string })?.name ?? r.code),
      score: Math.round(Number(r.probability) * 100),
    }));
    progress.suggestions = suggestions;
    await completeRun(run.id as number, progress);
    console.log(
      `[discover] done scored=${progress.scored} suggestions=${suggestions.length}`
    );
    const scanned = progress.scored + progress.skipped;
    return {
      done: true,
      processed: scanned,
      total: scanned,
      runId: run.id as number,
      phase: "commit",
      message: `发现完成，建议纳入 ${suggestions.length} 只`,
      events: [
        ...events,
        {
          level: "info",
          text: `发现完成，打分 ${progress.scored}，跳过 ${progress.skipped}`,
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
