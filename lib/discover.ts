import { nextBatch } from "@/lib/batch";
import {
  fetchDailyKlines,
  fetchEastmoneyPage,
  fetchSinaPage,
  mapPool,
  type MarketSnapshot,
} from "@/lib/eastmoney";
import { filterCandidates } from "@/lib/filter";
import {
  buildExcellenceQuestion,
  parseScore,
} from "@/lib/jev";
import { decide } from "@/lib/jev-client";
import type { Market } from "@/lib/market";
import { getSupabase } from "@/lib/supabase";

export type DiscoverCandidate = {
  market: Market;
  code: string;
  name: string;
  changePct: number;
  amount: number;
  turnover: number;
  pe: number;
  volumeRatio: number;
  marketCap: number;
  pb: number;
};

export type DiscoverProgress = {
  phase: "snapshot" | "score" | "commit";
  candidates: DiscoverCandidate[];
  scores: { market: Market; code: string; name: string; score: number }[];
  cursor: number;
  processed: number;
  total: number;
  failedCodes: string[];
  snapshotSource: "eastmoney" | "sina" | null;
  snapshotPage: number;
  snapshotPages: number;
  sinaNode: "hs_a" | "hs_bjs";
};

export type StepEvent = {
  level: "info" | "ok" | "fail";
  text: string;
};

export type StepResult = {
  done: boolean;
  processed: number;
  total: number;
  runId: string;
  phase: string;
  message: string;
  events: StepEvent[];
};

const BATCH_SIZE = 30;
const FETCH_CONCURRENCY = 10;
const SNAPSHOT_PAGES_PER_STEP = 6;

function emptyProgress(): DiscoverProgress {
  return {
    phase: "snapshot",
    candidates: [],
    scores: [],
    cursor: 0,
    processed: 0,
    total: 0,
    failedCodes: [],
    snapshotSource: null,
    snapshotPage: 1,
    snapshotPages: 0,
    sinaNode: "hs_a",
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

export async function startDiscoverRun(): Promise<{ runId: string }> {
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
  return { runId: data.id };
}

async function saveProgress(runId: string, progress: DiscoverProgress) {
  const sb = getSupabase();
  const { error } = await sb
    .from("runs")
    .update({ progress })
    .eq("id", runId);
  if (error) throw error;
}

async function completeRun(runId: string, progress: DiscoverProgress) {
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

function appendCandidates(
  progress: DiscoverProgress,
  snaps: MarketSnapshot[]
): number {
  const seen = new Set(progress.candidates.map((c) => `${c.market}:${c.code}`));
  let added = 0;
  for (const snap of filterCandidates(snaps)) {
    const key = `${snap.market}:${snap.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    progress.candidates.push(toCandidate(snap));
    added += 1;
  }
  return added;
}

function finishSnapshot(progress: DiscoverProgress): StepEvent[] {
  progress.candidates.sort((a, b) => b.amount - a.amount);
  progress.phase = "score";
  progress.cursor = 0;
  progress.processed = 0;
  progress.total = progress.candidates.length;
  progress.scores = [];
  return [
    {
      level: "info",
      text: `粗筛完成，候选 ${progress.total} 只，开始打分`,
    },
  ];
}

function toCandidate(s: MarketSnapshot): DiscoverCandidate {
  return {
    market: s.market,
    code: s.code,
    name: s.name,
    changePct: s.changePct,
    amount: s.amount,
    turnover: s.turnover,
    pe: s.pe,
    volumeRatio: s.volumeRatio,
    marketCap: s.marketCap,
    pb: s.pb,
  };
}

export async function stepDiscover(runId?: string): Promise<StepResult> {
  const sb = getSupabase();
  let run;
  if (runId) {
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

  let progress = asProgress(run.progress);

  if (progress.phase === "snapshot") {
    const events: StepEvent[] = [];
    let added = 0;
    let scoring = false;

    if (!progress.snapshotSource) {
      try {
        const first = await fetchEastmoneyPage(1, 100);
        progress.snapshotSource = "eastmoney";
        progress.snapshotPages = Math.max(1, Math.ceil(first.total / 100));
        progress.snapshotPage = 2;
        progress.total = progress.snapshotPages;
        progress.processed = 1;
        added += appendCandidates(progress, first.items);
      } catch {
        progress.snapshotSource = "sina";
        progress.sinaNode = "hs_a";
        progress.snapshotPage = 1;
        progress.snapshotPages = 0;
        events.push({
          level: "info",
          text: "东财快照不可用，改用新浪榜单分页抓取",
        });
      }
    }

    if (progress.snapshotSource === "eastmoney") {
      const start = progress.snapshotPage;
      const end = Math.min(
        progress.snapshotPages,
        start + SNAPSHOT_PAGES_PER_STEP - 1
      );
      if (start <= end) {
        const pages = await Promise.all(
          Array.from({ length: end - start + 1 }, (_, i) =>
            fetchEastmoneyPage(start + i, 100)
          )
        );
        for (const page of pages) added += appendCandidates(progress, page.items);
        progress.snapshotPage = end + 1;
        progress.processed = Math.min(end, progress.snapshotPages);
        progress.total = progress.snapshotPages;
      }
      events.push({
        level: "info",
        text: `快照 ${progress.processed}/${progress.total} 页，本步新增候选 ${added}，累计 ${progress.candidates.length}`,
      });
      if (progress.snapshotPage > progress.snapshotPages) {
        events.push(...finishSnapshot(progress));
        scoring = true;
      }
    } else {
      const node = progress.sinaNode;
      let empty = false;
      for (let i = 0; i < SNAPSHOT_PAGES_PER_STEP; i++) {
        const page = progress.snapshotPage;
        const items = await fetchSinaPage(node, page);
        progress.snapshotPage = page + 1;
        progress.processed += 1;
        if (items.length === 0) {
          empty = true;
          break;
        }
        added += appendCandidates(progress, items);
      }
      const nodeLabel = node === "hs_a" ? "沪深" : "北证";
      events.push({
        level: "info",
        text: `${nodeLabel}快照第 ${Math.max(1, progress.snapshotPage - 1)} 页，本步新增候选 ${added}，累计 ${progress.candidates.length}`,
      });
      if (empty) {
        if (node === "hs_a") {
          progress.sinaNode = "hs_bjs";
          progress.snapshotPage = 1;
          events.push({ level: "info", text: "沪深榜单结束，继续抓北证" });
        } else {
          progress.total = progress.processed;
          events.push(...finishSnapshot(progress));
          scoring = true;
        }
      }
      if (progress.total < progress.processed) {
        progress.total = progress.processed + (empty ? 0 : SNAPSHOT_PAGES_PER_STEP);
      }
    }

    await saveProgress(run.id, progress);
    const message = scoring
      ? `粗筛完成，候选 ${progress.total} 只`
      : (events[events.length - 1]?.text ?? "正在抓取全市场快照");
    return {
      done: false,
      processed: scoring ? 0 : progress.processed,
      total: progress.total,
      runId: run.id,
      phase: progress.phase,
      message,
      events,
    };
  }

  if (progress.phase === "score") {
    const { batch, nextCursor, done } = nextBatch(
      progress.candidates,
      progress.cursor,
      BATCH_SIZE
    );

    const scored = await mapPool(batch, FETCH_CONCURRENCY, async (c) => {
      try {
        const klines = await fetchDailyKlines(c.market, c.code, 5);
        if (klines.length === 0) {
          return { ok: false as const, code: c.code, name: c.name };
        }
        const state = {
          snapshot: {
            name: c.name,
            market: c.market,
            code: c.code,
            marketCap: c.marketCap,
            pe: c.pe,
            pb: c.pb,
            turnover: c.turnover,
            volumeRatio: c.volumeRatio,
            changePct: c.changePct,
            amount: c.amount,
          },
          dailyKlines: klines,
        };
        const resp = await decide(state, buildExcellenceQuestion());
        const parsed = parseScore(resp, "excellence");
        await sb.from("judgments").insert({
          run_id: run.id,
          market: c.market,
          code: c.code,
          kind: "score",
          probability: parsed.probability,
          details: parsed.details,
        });
        return {
          ok: true as const,
          row: {
            market: c.market,
            code: c.code,
            name: c.name,
            score: parsed.displayScore,
          },
        };
      } catch {
        return { ok: false as const, code: c.code, name: c.name };
      }
    });

    const events: StepEvent[] = [];
    for (const r of scored) {
      if (r.ok) {
        progress.scores.push(r.row);
        events.push({
          level: "ok",
          text: `${r.row.code} ${r.row.name}  AI分 ${r.row.score}`,
        });
      } else {
        progress.failedCodes.push(r.code);
        events.push({
          level: "fail",
          text: `${r.code} ${r.name}  本批跳过`,
        });
      }
    }
    progress.cursor = nextCursor;
    progress.processed = nextCursor;

    if (done) {
      progress.phase = "commit";
    }
    await saveProgress(run.id, progress);

    const okCount = events.filter((e) => e.level === "ok").length;
    const failCount = events.filter((e) => e.level === "fail").length;
    const message = `打分 ${progress.processed}/${progress.total} · 本批成功 ${okCount}，跳过 ${failCount} · 累计失败 ${progress.failedCodes.length}`;

    if (!done) {
      return {
        done: false,
        processed: progress.processed,
        total: progress.total,
        runId: run.id,
        phase: progress.phase,
        message,
        events,
      };
    }
  }

  // commit: Top 10 替换 ai 池
  const { data: manuals, error: mErr } = await sb
    .from("watchlist")
    .select("market,code")
    .eq("source", "manual");
  if (mErr) throw mErr;
  const manualKeys = new Set(
    (manuals ?? []).map((m) => `${m.market}:${m.code}`)
  );

  const ranked = [...progress.scores]
    .sort((a, b) => b.score - a.score)
    .filter((s) => !manualKeys.has(`${s.market}:${s.code}`))
    .slice(0, 10);

  const { error: delErr } = await sb
    .from("watchlist")
    .delete()
    .eq("source", "ai");
  if (delErr) throw delErr;

  if (ranked.length > 0) {
    const { error: insErr } = await sb.from("watchlist").insert(
      ranked.map((r) => ({
        market: r.market,
        code: r.code,
        name: r.name,
        source: "ai",
        score: r.score,
      }))
    );
    if (insErr) throw insErr;
  }

  progress.phase = "commit";
  progress.processed = progress.total;
  await completeRun(run.id, progress);

  const topLines = ranked.map(
    (r, i) => `${i + 1}. ${r.code} ${r.name}  ${r.score}`
  );
  return {
    done: true,
    processed: progress.processed,
    total: progress.total,
    runId: run.id,
    phase: "commit",
    message: `发现完成，写入观察池 ${ranked.length} 只`,
    events: [
      { level: "info", text: `发现完成，AI 观察池 ${ranked.length} 只（手动股票保留）` },
      ...topLines.map((text) => ({ level: "ok" as const, text })),
    ],
  };
}
