import { getMarketData, type KlineBar } from "@/lib/market-data";
import {
  deriveDailyFeatures,
  deriveTrendIndicators,
  type DailyFeatures,
  type TrendIndicators,
} from "@/lib/filter";
import { buildTrendQuestions, parseNoul, parseScore, scoreIndexToDisplay } from "@/lib/jev";
import { decide, jevRequest, type JevPrompt } from "@/lib/jev-client";
import { limitPct, type Market } from "@/lib/market";
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
  entryPrice: number | null;
  addedAt: string | null;
  score: number | null;
  quantity: number | null;
};

export type PollProgress = {
  phase: "context" | "items" | "done";
  context: {
    indexDaily: KlineBar[];
  } | null;
  queue: PollQueueItem[];
  cursor: number;
  processed: number;
  total: number;
  failedCodes: string[];
};

const BATCH_SIZE = 1;
/** 趋势复盘期间必盈请求至少间隔 1 秒，避免 60 秒内把日 K 和三项指标一起打出去。 */
const REVIEW_GAP_MS = 1000;

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
  const existing = await anyRunningRun();
  if (existing) {
    const err = new Error("已有任务在运行") as Error & { status: number };
    err.status = 409;
    throw err;
  }

  const sb = getSupabase();
  const [{ data: watch }, { data: holds }] = await Promise.all([
    sb.from("watchlist").select("market,code,name,entry_price,added_at,score"),
    sb
      .from("holdings")
      .select("market,code,name,quantity,entry_price,added_at"),
  ]);

  const queue: PollQueueItem[] = [
    ...(watch ?? []).map((w) => ({
      market: w.market as Market,
      code: w.code as string,
      name: w.name as string,
      kind: "buy" as const,
      entryPrice: (w.entry_price as number | null) ?? null,
      addedAt: (w.added_at as string | null) ?? null,
      score: (w.score as number | null) ?? null,
      quantity: null,
    })),
    ...(holds ?? []).map((h) => ({
      market: h.market as Market,
      code: h.code as string,
      name: h.name as string,
      kind: "sell" as const,
      entryPrice: (h.entry_price as number | null) ?? null,
      addedAt: (h.added_at as string | null) ?? null,
      score: null,
      quantity: (h.quantity as number | null) ?? null,
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

function roundFeatureMap(
  features: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(features)) {
    out[k] = typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : v;
  }
  return out;
}

function trendFeatures(daily: DailyFeatures, trend: TrendIndicators) {
  return roundFeatureMap({
    maAlign: daily.maAlign,
    ret20: daily.ret20,
    bias20: daily.bias20,
    ddFromHigh60: daily.ddFromHigh60,
    rs60: daily.rs60,
    ...trend,
  });
}

async function judgeTrend(input: {
  kind: "buy" | "sell";
  daily: DailyFeatures;
  trend: TrendIndicators;
}): Promise<{
  probability: number;
  trendScore: number;
  tag: string;
  parts: Record<string, number>;
  prompt: JevPrompt | null;
}> {
  const features = trendFeatures(input.daily, input.trend);
  const questions = buildTrendQuestions(input.kind);
  const prompt = jevRequest({ features }, questions);
  const resp = await decide({ features }, questions);
  const scored = parseScore(resp, "trend");
  const canAct = parseNoul(resp, "canAct").probability;
  const conclusion =
    input.kind === "buy"
      ? canAct >= 0.5
        ? "可入"
        : "观望"
      : canAct >= 0.5
        ? "可卖"
        : "持有";
  return {
    probability: canAct,
    trendScore: scored.displayScore,
    tag: `${scored.displayScore} · ${conclusion}`,
    parts: { trend: scored.probability, canAct },
    prompt,
  };
}

export async function stepPoll(runId?: number): Promise<StepResult> {
  getMarketData().setMinGap(REVIEW_GAP_MS);
  try {
    return await stepPollBody(runId);
  } finally {
    getMarketData().setMinGap(0);
  }
}

async function stepPollBody(runId?: number): Promise<StepResult> {
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

  if (progress.phase === "context" || !progress.context?.indexDaily) {
    const indexDaily = await getMarketData().fetchIndexDaily(120);
    progress.context = { indexDaily };
    progress.phase = "items";
    await saveProgress(run.id as number, progress);
    console.log(`[poll] context ready indexBars=${indexDaily.length}`);
    return {
      done: false,
      processed: progress.processed,
      total: progress.total,
      runId: run.id as number,
      phase: progress.phase,
      message: "已抓取上证日 K，开始逐只复盘",
      events: [
        {
          level: "info",
          text: `已抓取上证日 K ${indexDaily.length} 根`,
        },
      ],
    };
  }

  const batch = progress.queue.slice(
    progress.cursor,
    progress.cursor + BATCH_SIZE
  );
  const quotes = await getMarketData().fetchQuotes(
    batch.map((b) => ({ market: b.market, code: b.code }))
  );
  const quoteMap = new Map(quotes.map((q) => [`${q.market}:${q.code}`, q]));

  for (const item of batch) {
    try {
      const dailyBars = await getMarketData().fetchDailyKlines(item.market, item.code, 60);
      const indicators = await getMarketData().fetchDailyIndicators(item.market, item.code, 30);
      if (dailyBars.length === 0) {
        progress.failedCodes.push(item.code);
        events.push({
          level: "fail",
          text: `${item.code} ${item.name} 无日 K，跳过`,
        });
        console.log(`[poll] fail ${item.code} 无日 K`);
        continue;
      }
      const quote = quoteMap.get(`${item.market}:${item.code}`);
      const close = dailyBars.at(-1)!.close;
      const price = quote && quote.price > 0 ? quote.price : close;
      const daily = deriveDailyFeatures(dailyBars, {
        limitPct: limitPct(item.market, item.code),
        indexBars: progress.context.indexDaily,
      });
      const trend = deriveTrendIndicators({
        close,
        macd: indicators.macd,
        kdj: indicators.kdj,
        boll: indicators.boll,
      });
      const judged = await judgeTrend({
        kind: item.kind,
        daily,
        trend,
      });
      const nowIso = new Date().toISOString();
      const pricePatch = price > 0 ? { last_price: price } : {};
      const features = trendFeatures(daily, trend);
      if (item.kind === "buy") {
        await sb
          .from("watchlist")
          .update({
            latest_buy_probability: judged.probability,
            latest_buy_at: nowIso,
            latest_buy_tag: judged.tag,
            prompt: judged.prompt,
            ...pricePatch,
          })
          .eq("market", item.market)
          .eq("code", item.code);
      } else {
        await sb
          .from("holdings")
          .update({
            latest_sell_probability: judged.probability,
            latest_sell_at: nowIso,
            latest_sell_tag: judged.tag,
            prompt: judged.prompt,
            ...pricePatch,
          })
          .eq("market", item.market)
          .eq("code", item.code);
      }
      await sb.from("judgments").insert({
        run_id: run.id,
        market: item.market,
        code: item.code,
        kind: item.kind,
        probability: judged.probability,
        prompt: judged.prompt,
        details: {
          name: item.name,
          tag: judged.tag,
          trendScore: judged.trendScore,
          parts: judged.parts,
          features,
        },
      });
      const pctText = `${(judged.probability * 100).toFixed(1)}%`;
      events.push({
        level: "ok",
        text: `${item.code} ${item.name}  ${judged.tag} ${pctText}`,
      });
      console.log(`[poll] ${item.kind} ${item.code} ${item.name} ${judged.tag} ${pctText}`);
    } catch (e) {
      const skipped = e instanceof Error && "skip" in e && (e as { skip?: boolean }).skip;
      const reason = e instanceof Error ? e.message : "未知错误";
      if (skipped) {
        events.push({
          level: "info",
          text: `${item.code} ${item.name} 跳过：${reason}`,
        });
        console.log(`[poll] skip ${item.code} ${reason}`);
      } else {
        progress.failedCodes.push(item.code);
        events.push({
          level: "fail",
          text: `${item.code} ${item.name} 失败：${reason}`,
        });
        console.log(`[poll] fail ${item.code} ${reason}`);
      }
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
      message: `复盘完成 ${progress.processed}/${progress.total}`,
      events: [
        ...events,
        {
          level: "info",
          text: `复盘完成，失败 ${progress.failedCodes.length} 只`,
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
    message: `复盘 ${progress.processed}/${progress.total}`,
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
