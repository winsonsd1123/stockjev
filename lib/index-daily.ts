import { getMarketData, type KlineBar } from "@/lib/market-data";
import { shanghaiMinutes, shanghaiYmd } from "@/lib/session";
import { getSupabase } from "@/lib/supabase";

const INDEX_BARS = 120;
const PUBLISH_MINUTES = 16 * 60;

/** 16:00 前沿用上一交易日；当天已有 K，或 16:00 后已经刷新过，就不再向必盈要。 */
export function indexDailyStillFresh(
  lastBarDate: string,
  updatedAt: Date,
  now: Date = new Date()
): boolean {
  const barDay = lastBarDate.slice(0, 10);
  const today = shanghaiYmd(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(barDay)) return false;
  if (barDay >= today) return true;
  if (shanghaiMinutes(now) < PUBLISH_MINUTES) return true;
  return (
    shanghaiYmd(updatedAt) === today &&
    shanghaiMinutes(updatedAt) >= PUBLISH_MINUTES
  );
}

function asBars(raw: unknown): KlineBar[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row): row is KlineBar => {
    if (!row || typeof row !== "object") return false;
    const bar = row as KlineBar;
    return typeof bar.date === "string" && typeof bar.close === "number";
  });
}

export async function getIndexDaily(): Promise<KlineBar[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("index_daily")
    .select("bars,updated_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const cached = asBars(data?.bars);
  const updatedAt = data?.updated_at ? new Date(data.updated_at as string) : null;
  const last = cached.at(-1);
  if (last && updatedAt && indexDailyStillFresh(last.date, updatedAt)) {
    return cached.slice(-INDEX_BARS);
  }

  const bars = await getMarketData().fetchIndexDaily(INDEX_BARS);
  const { error: writeError } = await sb.from("index_daily").upsert({
    id: 1,
    bars,
    updated_at: new Date().toISOString(),
  });
  if (writeError) throw new Error(writeError.message);
  return bars;
}
