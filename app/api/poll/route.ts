import { NextResponse } from "next/server";
import type { Market } from "@/lib/market";
import { startPollRun, type PollTarget } from "@/lib/poll";

export const runtime = "nodejs";
export const maxDuration = 60;

function targetOf(body: unknown): PollTarget | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = body as { market?: unknown; code?: unknown; kind?: unknown };
  if (raw.market == null && raw.code == null && raw.kind == null) return undefined;
  const market = raw.market;
  const code = typeof raw.code === "string" ? raw.code : "";
  const kind = raw.kind;
  if (
    (market !== "sh" && market !== "sz" && market !== "bj") ||
    !/^\d{6}$/.test(code) ||
    (kind !== "buy" && kind !== "sell")
  ) {
    const err = new Error("单只复盘参数无效") as Error & { status: number };
    err.status = 400;
    throw err;
  }
  return { market: market as Market, code, kind };
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const result = await startPollRun(targetOf(body));
    return NextResponse.json(result);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    const msg =
      e instanceof Error
        ? e.message
        : e && typeof e === "object" && "message" in e && typeof e.message === "string"
          ? e.message
          : "poll start error";
    return NextResponse.json({ error: msg }, { status });
  }
}
