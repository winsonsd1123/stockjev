import { NextResponse } from "next/server";
import { startPollRun } from "@/lib/poll";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST() {
  try {
    const result = await startPollRun();
    return NextResponse.json(result);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    const msg = e instanceof Error ? e.message : "poll start error";
    return NextResponse.json({ error: msg }, { status });
  }
}
