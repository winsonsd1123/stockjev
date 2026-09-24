import {
  fetchDailyKlines,
  fetchIndexContext,
  fetchIntraday5m,
  fetchQuotes,
  isShanghaiTradingDay,
  type KlineBar,
} from "@/lib/eastmoney";
import {
  deriveDailyFeatures,
  deriveIntradayFeatures,
  derivePositionFeatures,
  priorAvgVolume,
  priorHigh,
  type DailyFeatures,
  type IntradayFeatures,
  type PositionFeatures,
} from "@/lib/filter";
import {
  buildBuyQuestions,
  buildIndexQuestion,
  buildSellQuestions,
  composeBuy,
  composeSell,
  parseNouls,
} from "@/lib/jev";
import { decide } from "@/lib/jev-client";
import { limitPct, type Market } from "@/lib/market";
import { applyCap, buyGate, sellGate } from "@/lib/rules";
import { isLateSession, isTradingSession, sessionProgress } from "@/lib/session";
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
    indexIntraday5m: KlineBar[];
    indexDaily: KlineBar[];
    indexIntradayRet: number | null;
    indexRet5: number | null;
    indexOk: number;
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

function indexIntradayReturn(
  intraday: KlineBar[],
  daily: KlineBar[]
): number | null {
  if (intraday.length === 0 || daily.length < 2) return null;
  const prev = daily[daily.length - 2].close;
  const last = intraday[intraday.length - 1].close;
  if (!(prev > 0) || !(last > 0)) return null;
  return last / prev - 1;
}

function ret5Of(daily: KlineBar[]): number | null {
  if (daily.length < 6) return null;
  const prev = daily[daily.length - 6].close;
  const last = daily[daily.length - 1].close;
  if (!(prev > 0)) return null;
  return last / prev - 1;
}

async function judgeIndex(ctx: {
  intraday5m: KlineBar[];
  daily: KlineBar[];
  intradayRet: number | null;
  ret5: number | null;
}): Promise<number> {
  let amount = 0;
  let vol = 0;
  for (const b of ctx.intraday5m) {
    if (b.amount > 0 && b.volume > 0) {
      amount += b.amount;
      vol += b.volume;
    }
  }
  const vwap = vol > 0 ? amount / (vol * 100) : null;
  const price = ctx.intraday5m.at(-1)?.close ?? null;
  try {
    const resp = await decide(
      {
        index: {
          intradayRet: ctx.intradayRet,
          ret5: ctx.ret5,
          price,
          vwap,
        },
      },
      buildIndexQuestion()
    );
    return parseNouls(resp, ["indexOk"]).indexOk;
  } catch {
    return 0.5;
  }
}

async function judgeBuy(input: {
  item: PollQueueItem;
  daily: DailyFeatures;
  intra: IntradayFeatures;
  position: PositionFeatures;
  indexOk: number;
  indexRet5: number | null;
  price: number;
  vwap: number | null;
}): Promise<{ probability: number; tag: string | null; parts: Record<string, number> }> {
  const gate = buyGate({
    isLimitUp: input.intra.isLimitUp,
    isOneWordBoard: input.intra.isOneWordBoard,
    isLimitDown: input.intra.isLimitDown,
    barsCount: input.intra.barsCount,
    afterCloseAuction: isLateSession(),
    ret20: input.daily.ret20,
    pos20: input.daily.pos20,
    limitUpCount20: input.daily.limitUpCount20,
    changePct: input.intra.changePct,
    wideLimit: limitPct(input.item.market, input.item.code) >= 0.2,
  });
  if (gate.action === "skip") {
    const err = new Error(gate.tag ?? "跳过") as Error & { skip: boolean };
    err.skip = true;
    throw err;
  }
  if (gate.action === "force") {
    return {
      probability: gate.probability ?? 0,
      tag: gate.tag ?? null,
      parts: {},
    };
  }
  const features = roundFeatureMap({
    ...input.daily,
    ...input.intra,
    price: input.price,
    vwap: input.vwap,
    sinceEntryPct: input.position.pnlPct,
    daysSinceAdded: input.position.holdingDays,
    discoverScore: input.item.score,
    rs5:
      input.daily.ret5 != null && input.indexRet5 != null
        ? Math.round((input.daily.ret5 - input.indexRet5) * 10000) / 10000
        : null,
  });
  const resp = await decide({ features }, buildBuyQuestions());
  const raw = parseNouls(resp, [
    "chaseRisk",
    "strongerThanIndex",
    "validBreakout",
    "pullbackEntry",
  ]);
  const probability = applyCap(
    composeBuy(
      {
        chaseRisk: raw.chaseRisk,
        strongerThanIndex: raw.strongerThanIndex,
        validBreakout: raw.validBreakout,
        pullbackEntry: raw.pullbackEntry,
      },
      input.indexOk
    ),
    gate.cap
  );
  return { probability, tag: gate.tag ?? null, parts: raw };
}

async function judgeSell(input: {
  item: PollQueueItem;
  daily: DailyFeatures;
  intra: IntradayFeatures;
  position: PositionFeatures;
  price: number;
  vwap: number | null;
}): Promise<{ probability: number; tag: string | null; parts: Record<string, number> }> {
  const gate = sellGate({
    isLimitUp: input.intra.isLimitUp,
    isLimitDown: input.intra.isLimitDown,
    boughtToday: input.position.boughtToday,
    afterCloseAuction: isLateSession(),
    barsCount: input.intra.barsCount,
    pnlPct: input.position.pnlPct,
    belowAtrStop: input.position.belowAtrStop,
  });
  if (gate.action === "skip") {
    const err = new Error(gate.tag ?? "跳过") as Error & { skip: boolean };
    err.skip = true;
    throw err;
  }
  if (gate.action === "force") {
    return {
      probability: gate.probability ?? 0,
      tag: gate.tag ?? null,
      parts: {},
    };
  }
  const features = roundFeatureMap({
    ...input.daily,
    ...input.intra,
    ...input.position,
    price: input.price,
    vwap: input.vwap,
    quantity: input.item.quantity,
  });
  const resp = await decide({ features }, buildSellQuestions());
  const raw = parseNouls(resp, ["trendBroken", "takeProfit", "dipIsMarketDriven"]);
  let cap = gate.cap;
  if (input.intra.isLimitUp && raw.takeProfit >= 0.5) cap = undefined;
  const probability = applyCap(
    composeSell({
      trendBroken: raw.trendBroken,
      takeProfit: raw.takeProfit,
      dipIsMarketDriven: raw.dipIsMarketDriven,
    }),
    cap
  );
  return { probability, tag: gate.tag ?? null, parts: raw };
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
    const intradayRet = indexIntradayReturn(ctx.intraday5m, ctx.daily5);
    const ret5 = ret5Of(ctx.daily5);
    const indexOk = await judgeIndex({
      intraday5m: ctx.intraday5m,
      daily: ctx.daily5,
      intradayRet,
      ret5,
    });
    progress.context = {
      indexIntraday5m: ctx.intraday5m,
      indexDaily: ctx.daily5,
      indexIntradayRet: intradayRet,
      indexRet5: ret5,
      indexOk,
    };
    progress.phase = "items";
    await saveProgress(run.id as number, progress);
    console.log(`[poll] context ready indexOk=${indexOk}`);
    return {
      done: false,
      processed: progress.processed,
      total: progress.total,
      runId: run.id as number,
      phase: progress.phase,
      message: "已抓取大盘背景，开始逐只判断",
      events: [
        {
          level: "info",
          text: `已抓取上证背景，大盘允许买入 ${(indexOk * 100).toFixed(0)}%`,
        },
      ],
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
      const [bars5m, dailyBars] = await Promise.all([
        fetchIntraday5m(item.market, item.code),
        fetchDailyKlines(item.market, item.code, 60),
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
      const price = quote && quote.price > 0 ? quote.price : bars5m.at(-1)!.close;
      const pctRaw = quote ? quote.changePct / 100 : null;
      const daily = deriveDailyFeatures(dailyBars, {
        limitPct: limitPct(item.market, item.code),
        indexBars: progress.context.indexDaily,
      });
      const intra = deriveIntradayFeatures({
        bars5m,
        price,
        prevClose: quote?.prevClose ?? null,
        open: quote?.open ?? bars5m[0].open,
        high: quote?.high ?? Math.max(...bars5m.map((b) => b.high)),
        low: quote?.low ?? Math.min(...bars5m.map((b) => b.low)),
        changePct: pctRaw,
        todayVolume: bars5m.reduce((a, b) => a + b.volume, 0),
        avgVol20: priorAvgVolume(dailyBars, 20),
        sessionProgress: sessionProgress(),
        maxHigh20Prev: priorHigh(dailyBars, 20),
        limitPct: limitPct(item.market, item.code),
        indexIntradayRet: progress.context.indexIntradayRet,
      });
      const position = derivePositionFeatures({
        entryPrice: item.entryPrice,
        addedAt: item.addedAt,
        price,
        dailyBars,
      });
      const judged =
        item.kind === "buy"
          ? await judgeBuy({
              item,
              daily,
              intra,
              position,
              indexOk: progress.context.indexOk,
              indexRet5: progress.context.indexRet5,
              price,
              vwap: intra.vwap,
            })
          : await judgeSell({
              item,
              daily,
              intra,
              position,
              price,
              vwap: intra.vwap,
            });
      const nowIso = new Date().toISOString();
      const pricePatch = price > 0 ? { last_price: price } : {};
      const features = roundFeatureMap({
        ...daily,
        ...intra,
        pnlPct: position.pnlPct,
      });
      if (item.kind === "buy") {
        await sb
          .from("watchlist")
          .update({
            latest_buy_probability: judged.probability,
            latest_buy_at: nowIso,
            latest_buy_tag: judged.tag,
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
        details: {
          name: item.name,
          tag: judged.tag,
          parts: judged.parts,
          features,
          indexOk: progress.context.indexOk,
        },
      });
      const pctText = `${(judged.probability * 100).toFixed(1)}%`;
      const tagText = judged.tag ? ` ${judged.tag}` : "";
      events.push({
        level: "ok",
        text: `${item.code} ${item.name}  ${item.kind === "buy" ? "买入" : "卖出"} ${pctText}${tagText}`,
      });
      console.log(
        `[poll] ${item.kind} ${item.code} ${item.name} ${pctText}${tagText}`
      );
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
