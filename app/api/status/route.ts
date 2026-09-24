import { NextResponse } from "next/server";
import { anyRunningRun } from "@/lib/discover";
import { isShanghaiTradingDay } from "@/lib/eastmoney";
import { lastCompletedPollAt } from "@/lib/poll";
import { isTradingSession } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";

function slimProgress(progress: unknown) {
  if (!progress || typeof progress !== "object") return {};
  const p = progress as Record<string, unknown>;
  return {
    phase: p.phase,
    processed: p.processed ?? p.scored,
    total: p.total,
    cursor: p.cursor ?? p.pageCursor,
    failedCodes: p.failedCodes,
    suggestions: p.suggestions,
    scored: p.scored,
    skipped: p.skipped,
  };
}

export async function GET() {
  try {
    const [running, lastPollAt] = await Promise.all([
      anyRunningRun(),
      lastCompletedPollAt(),
    ]);

    let tradingDay = false;
    let tradingDayError: string | null = null;
    try {
      tradingDay = await isShanghaiTradingDay();
    } catch (e) {
      tradingDayError = e instanceof Error ? e.message : "交易日判定失败";
    }

    const sb = getSupabase();
    const { data: lastDiscover } = await sb
      .from("runs")
      .select("id,progress,finished_at")
      .eq("type", "discover")
      .eq("status", "completed")
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const suggestions =
      (lastDiscover?.progress as { suggestions?: unknown[] } | null)
        ?.suggestions ?? [];

    return NextResponse.json({
      running: running
        ? {
            id: running.id,
            type: running.type,
            progress: slimProgress(running.progress),
          }
        : null,
      lastPollAt,
      tradingDay,
      tradingSession: isTradingSession(tradingDay),
      tradingDayError,
      suggestions,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "status error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
