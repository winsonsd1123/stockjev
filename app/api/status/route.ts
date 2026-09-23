import { NextResponse } from "next/server";
import { anyRunningRun } from "@/lib/discover";
import { isShanghaiTradingDay } from "@/lib/eastmoney";
import { lastCompletedPollAt } from "@/lib/poll";
import { isTradingSession } from "@/lib/session";

export const runtime = "nodejs";

function slimProgress(progress: unknown) {
  if (!progress || typeof progress !== "object") return {};
  const p = progress as Record<string, unknown>;
  return {
    phase: p.phase,
    processed: p.processed,
    total: p.total,
    cursor: p.cursor,
    failedCodes: p.failedCodes,
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

    const tradingSession = isTradingSession(tradingDay);
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
      tradingSession,
      tradingDayError,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "status error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
