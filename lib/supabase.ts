import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY");
  }
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

export type WatchlistRow = {
  id: number;
  market: string;
  code: string;
  name: string;
  source: "ai" | "manual";
  score: number | null;
  entry_price: number | null;
  latest_buy_probability: number | null;
  latest_buy_at: string | null;
  added_at: string;
};

export type HoldingRow = {
  id: number;
  market: string;
  code: string;
  name: string;
  quantity: number;
  entry_price: number | null;
  latest_sell_probability: number | null;
  latest_sell_at: string | null;
  added_at: string;
};

export type RunRow = {
  id: number;
  type: "discover" | "poll";
  status: "running" | "completed";
  progress: Record<string, unknown>;
  created_at: string;
  finished_at: string | null;
};

export type JudgmentRow = {
  id: number;
  run_id: number;
  market: string;
  code: string;
  kind: "score" | "buy" | "sell";
  probability: number;
  details: Record<string, unknown>;
  created_at: string;
};
