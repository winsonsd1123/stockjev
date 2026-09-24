import { NextResponse } from "next/server";
import { resolveStock } from "@/lib/eastmoney";
import { normalizeCode } from "@/lib/market";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET() {
  try {
    const sb = getSupabase();
    const { data: rows, error } = await sb
      .from("watchlist")
      .select("*")
      .order("added_at", { ascending: false });
    if (error) throw error;

    const items = (rows ?? []).map((row) => ({
      ...row,
      latestBuyProbability: row.latest_buy_probability,
      latestBuyAt: row.latest_buy_at,
      entryPrice: row.entry_price,
      judgments: [] as unknown[],
    }));

    return NextResponse.json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "watchlist get error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      code?: string;
      score?: number | null;
    };
    const code = normalizeCode(body.code ?? "");
    const stock = await resolveStock(code);
    const sb = getSupabase();
    const { data, error } = await sb
      .from("watchlist")
      .upsert(
        {
          market: stock.market,
          code: stock.code,
          name: stock.name,
          source: "manual",
          score: body.score ?? null,
          entry_price: stock.price > 0 ? stock.price : null,
        },
        { onConflict: "market,code" }
      )
      .select("*")
      .single();
    if (error) throw error;
    return NextResponse.json({ item: data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "watchlist add error";
    const status = msg.includes("找不到") || msg.includes("须为") ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "缺少 id" }, { status: 400 });
    }
    const sb = getSupabase();
    const { error } = await sb.from("watchlist").delete().eq("id", Number(id));
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "watchlist delete error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
