import { NextResponse } from "next/server";
import { stepPoll } from "@/lib/poll";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { runId?: string };
    const result = await stepPoll(body.runId);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "poll step error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
