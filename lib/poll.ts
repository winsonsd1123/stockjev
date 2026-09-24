import {
  fetchDailyKlines,
  fetchIndexContext,
  fetchIntraday5m,
  fetchQuotes,
  isShanghaiTradingDay,
  type KlineBar,
  type QuoteLite,
} from "@/lib/eastmoney";
import { buildBuyQuestion, buildSellQuestion, parseNoul } from "@/lib/jev";
import { decide } from "@/lib/jev-client";
import type { Market } from "@/lib/market";
import { isTradingSession } from "@/lib/session";
import {
  anyRunningRun,
  getRunningRun,
  type StepEvent,
  type StepResult,
} from "@/lib/discover";
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
    indexIntraday5m: KlineBar[];
    indexDaily5: KlineBar[];
  } | null;
  queue: PollQueueItem[];
  cursor: number;
  processed: number;
  total: number;
  failedCodes: string[];
};

const BATCH_SIZE = 5;

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
  | { skipped: false; runId: number }
> {
  const tradingDay = await isShanghaiTradingDay();
  if (!isTradingSession(tradingDay)) {
    console.log("[poll] skip 非交易时段");
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
    console.log("[poll] skip 池为空");
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
  console.log(`[poll] start run=${data.id} total=${queue.length}`);
  return { skipped: false, runId: data.id as number };
}

async function saveProgress(runId: number, progress: PollProgress) {
  const sb = getSupabase();
  const { error } = await sb
    .from("runs")
    .update({ progress })
    .eq("id", runId);
  if (error) throw error;
}

async function completeRun(runId: number, progress: PollProgress) {
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

async function judgeOne(
  item: PollQueueItem,
  context: PollProgress["context"],
  quote: QuoteLite | undefined,
  bars5m: KlineBar[],
  daily5: KlineBar[]
): Promise<{ probability: number }> {
  const state = {
    index: context,
    quote: quote
      ? {
          name: quote.name,
          price: quote.price,
          changePct: quote.changePct,
          volumeRatio: quote.volumeRatio,
          turnover: quote.turnover,
          amount: quote.amount,
          open: quote.open,
          high: quote.high,
          low: quote.low,
        }
      : { name: item.name },
    stock: { market: item.market, code: item.code, name: item.name },
    intraday5m: bars5m,
    daily5,
  };
  const questions =
    item.kind === "buy" ? buildBuyQuestion() : buildSellQuestion();
  const key = item.kind === "buy" ? "buy" : "sell";
  const resp = await decide(state, questions);
  return parseNoul(resp, key);
}

export async function stepPoll(runId?: number): Promise<StepResult> {
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
    run = await getRunningRun("poll");
  }
  if (!run || run.status !== "running") {
    throw new Error("没有进行中的 poll 任务");
  }

  const progress = asProgress(run.progress);
  const events: StepEvent[] = [];

  if (progress.phase === "context" || !progress.context) {
    const ctx = await fetchIndexContext();
    progress.context = {
      indexIntraday5m: ctx.intraday5m,
      indexDaily5: ctx.daily5,
    };
    progress.phase = "items";
    await saveProgress(run.id as number, progress);
    console.log("[poll] context ready");
    return {
      done: false,
      processed: progress.processed,
      total: progress.total,
      runId: run.id as number,
      phase: progress.phase,
      message: "已抓取大盘背景，开始逐只判断",
      events: [{ level: "info", text: "已抓取上证分时与近 5 日走势" }],
    };
  }

  const batch = progress.queue.slice(
    progress.cursor,
    progress.cursor + BATCH_SIZE
  );
  const quotes = await fetchQuotes(
    batch.map((b) => ({ market: b.market, code: b.code }))
  );
  const quoteMap = new Map(quotes.map((q) => [`${q.market}:${q.code}`, q]));

  for (const item of batch) {
    try {
      const [bars5m, daily5] = await Promise.all([
        fetchIntraday5m(item.market, item.code),
        fetchDailyKlines(item.market, item.code, 5),
      ]);
      if (bars5m.length === 0) {
        progress.failedCodes.push(item.code);
        events.push({
          level: "fail",
          text: `${item.code} ${item.name} 无分时，跳过`,
        });
        console.log(`[poll] fail ${item.code} 无分时`);
        continue;
      }
      const quote = quoteMap.get(`${item.market}:${item.code}`);
      const parsed = await judgeOne(
        item,
        progress.context,
        quote,
        bars5m,
        daily5
      );
      const nowIso = new Date().toISOString();
      if (item.kind === "buy") {
        await sb
          .from("watchlist")
          .update({
            latest_buy_probability: parsed.probability,
            latest_buy_at: nowIso,
          })
          .eq("market", item.market)
          .eq("code", item.code);
      } else {
        await sb
          .from("holdings")
          .update({
            latest_sell_probability: parsed.probability,
            latest_sell_at: nowIso,
          })
          .eq("market", item.market)
          .eq("code", item.code);
      }
      const pct = `${(parsed.probability * 100).toFixed(1)}%`;
      events.push({
        level: "ok",
        text: `${item.code} ${item.name}  ${item.kind === "buy" ? "买入" : "卖出"} ${pct}`,
      });
      console.log(
        `[poll] ${item.kind} ${item.code} ${item.name} ${pct}`
      );
    } catch (e) {
      const reason = e instanceof Error ? e.message : "未知错误";
      progress.failedCodes.push(item.code);
      events.push({
        level: "fail",
        text: `${item.code} ${item.name} 失败：${reason}`,
      });
      console.log(`[poll] fail ${item.code} ${reason}`);
    }
  }

  progress.cursor += batch.length;
  progress.processed = progress.cursor;
  await saveProgress(run.id as number, progress);

  if (progress.cursor >= progress.queue.length) {
    await completeRun(run.id as number, progress);
    console.log(`[poll] done processed=${progress.processed}`);
    return {
      done: true,
      processed: progress.processed,
      total: progress.total,
      runId: run.id as number,
      phase: "done",
      message: `轮询完成 ${progress.processed}/${progress.total}`,
      events: [
        ...events,
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
    runId: run.id as number,
    phase: progress.phase,
    message: `轮询 ${progress.processed}/${progress.total}`,
    events,
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
