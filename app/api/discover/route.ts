import { NextResponse } from "next/server";
import { startDiscoverRun } from "@/lib/discover";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST() {
  try {
    const { runId } = await startDiscoverRun();
    return NextResponse.json({ runId });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    const msg = e instanceof Error ? e.message : "discover start error";
    return NextResponse.json({ error: msg }, { status });
  }
}
