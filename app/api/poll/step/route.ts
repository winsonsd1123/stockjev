import { NextResponse } from "next/server";
import { stepPoll } from "@/lib/poll";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { runId?: number | string };
    const runId =
      body.runId == null || body.runId === ""
        ? undefined
        : Number(body.runId);
    const result = await stepPoll(
      runId != null && Number.isFinite(runId) ? runId : undefined
    );
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "poll step error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
