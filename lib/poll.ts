import { nextBatch } from "@/lib/batch";
import {
  fetchIndexContext,
  fetchIntraday5m,
  fetchQuotes,
  isShanghaiTradingDay,
  mapPool,
  type KlineBar,
} from "@/lib/eastmoney";
import { buildBuyQuestion, buildSellQuestion, parseNoul } from "@/lib/jev";
import { decide } from "@/lib/jev-client";
import type { Market } from "@/lib/market";
import { isTradingSession } from "@/lib/session";
import { anyRunningRun, getRunningRun, type StepResult } from "@/lib/discover";
import { getSupabase } from "@/lib/supabase";

export type PollQueueItem = {
  market: Market;
  code: string;
  name: string;
  kind: "buy" | "sell";
};

export type PollProgress = {
  phase: "context" | "items" | "done";
  context: {
    indexIntraday1m: KlineBar[];
    indexDaily5: KlineBar[];
  } | null;
  queue: PollQueueItem[];
  cursor: number;
  processed: number;
  total: number;
  failedCodes: string[];
};

const BATCH_SIZE = 10;
const FETCH_CONCURRENCY = 10;

function emptyProgress(): PollProgress {
  return {
    phase: "context",
    context: null,
    queue: [],
    cursor: 0,
    processed: 0,
    total: 0,
    failedCodes: [],
  };
}

function asProgress(raw: unknown): PollProgress {
  if (!raw || typeof raw !== "object") return emptyProgress();
  return { ...emptyProgress(), ...(raw as PollProgress) };
}

export async function startPollRun(): Promise<
  | { skipped: true; reason: string }
  | { skipped: false; runId: string }
> {
  const tradingDay = await isShanghaiTradingDay();
  if (!isTradingSession(tradingDay)) {
    return { skipped: true, reason: "非交易时段" };
  }

  const existing = await anyRunningRun();
  if (existing) {
    const err = new Error("已有任务在运行") as Error & { status: number };
    err.status = 409;
    throw err;
  }

  const sb = getSupabase();
  const [{ data: watch }, { data: holds }] = await Promise.all([
    sb.from("watchlist").select("market,code,name"),
    sb.from("holdings").select("market,code,name"),
  ]);

  const queue: PollQueueItem[] = [
    ...(watch ?? []).map((w) => ({
      market: w.market as Market,
      code: w.code as string,
      name: w.name as string,
      kind: "buy" as const,
    })),
    ...(holds ?? []).map((h) => ({
      market: h.market as Market,
      code: h.code as string,
      name: h.name as string,
      kind: "sell" as const,
    })),
  ];

  if (queue.length === 0) {
    return { skipped: true, reason: "观察池与持仓均为空" };
  }

  const progress: PollProgress = {
    ...emptyProgress(),
    queue,
    total: queue.length,
  };

  const { data, error } = await sb
    .from("runs")
    .insert({
      type: "poll",
      status: "running",
      progress,
    })
    .select("*")
    .single();
  if (error) throw error;
  return { skipped: false, runId: data.id };
}

async function saveProgress(runId: string, progress: PollProgress) {
  const sb = getSupabase();
  const { error } = await sb
    .from("runs")
    .update({ progress })
    .eq("id", runId);
  if (error) throw error;
}

async function completeRun(runId: string, progress: PollProgress) {
  const sb = getSupabase();
  const { error } = await sb
    .from("runs")
    .update({
      status: "completed",
      finished_at: new Date().toISOString(),
      progress: { ...progress, phase: "done" },
    })
    .eq("id", runId);
  if (error) throw error;
}

export async function stepPoll(runId?: string): Promise<StepResult> {
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
    run = await getRunningRun("poll");
  }
  if (!run || run.status !== "running") {
    throw new Error("没有进行中的 poll 任务");
  }

  let progress = asProgress(run.progress);

  if (progress.phase === "context" || !progress.context) {
    const ctx = await fetchIndexContext();
    progress.context = {
      indexIntraday1m: ctx.intraday1m,
      indexDaily5: ctx.daily5,
    };
    progress.phase = "items";
    await saveProgress(run.id, progress);
    return {
      done: false,
      processed: progress.processed,
      total: progress.total,
      runId: run.id,
      phase: progress.phase,
      message: "已抓取大盘背景，开始逐只判断",
      events: [{ level: "info", text: "已抓取上证分时与近 5 日走势" }],
    };
  }

  const { batch, nextCursor, done } = nextBatch(
    progress.queue,
    progress.cursor,
    BATCH_SIZE
  );

  const quotes = await fetchQuotes(
    batch.map((b) => ({ market: b.market, code: b.code }))
  );
  const quoteMap = new Map(quotes.map((q) => [`${q.market}:${q.code}`, q]));

  await mapPool(batch, FETCH_CONCURRENCY, async (item) => {
    try {
      const bars = await fetchIntraday5m(item.market, item.code);
      if (bars.length === 0) {
        progress.failedCodes.push(item.code);
        return;
      }
      const quote = quoteMap.get(`${item.market}:${item.code}`);
      const state = {
        index: progress.context,
        quote: quote
          ? {
              name: quote.name,
              changePct: quote.changePct,
              volumeRatio: quote.volumeRatio,
            }
          : { name: item.name },
        stock: { market: item.market, code: item.code, name: item.name },
        intraday5m: bars,
      };
      const questions =
        item.kind === "buy" ? buildBuyQuestion() : buildSellQuestion();
      const key = item.kind === "buy" ? "buy" : "sell";
      const resp = await decide(state, questions);
      const parsed = parseNoul(resp, key);
      await sb.from("judgments").insert({
        run_id: run.id,
        market: item.market,
        code: item.code,
        kind: item.kind,
        probability: parsed.probability,
        details: parsed.details,
      });
    } catch {
      progress.failedCodes.push(item.code);
    }
  });

  progress.cursor = nextCursor;
  progress.processed = nextCursor;
  await saveProgress(run.id, progress);

  if (done) {
    await completeRun(run.id, progress);
    return {
      done: true,
      processed: progress.processed,
      total: progress.total,
      runId: run.id,
      phase: "done",
      message: `轮询完成 ${progress.processed}/${progress.total}`,
      events: [
        {
          level: "info",
          text: `轮询完成，失败 ${progress.failedCodes.length} 只`,
        },
      ],
    };
  }

  return {
    done: false,
    processed: progress.processed,
    total: progress.total,
    runId: run.id,
    phase: progress.phase,
    message: `轮询 ${progress.processed}/${progress.total}`,
    events: [
      {
        level: "info",
        text: `本批 ${batch.length} 只，累计 ${progress.processed}/${progress.total}`,
      },
    ],
  };
}

export async function lastCompletedPollAt(): Promise<string | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("runs")
    .select("finished_at")
    .eq("type", "poll")
    .eq("status", "completed")
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.finished_at ?? null;
}
