import { NextResponse } from "next/server";
import { resolveStock } from "@/lib/eastmoney";
import { normalizeCode } from "@/lib/market";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET() {
  try {
    const sb = getSupabase();
    const { data: rows, error } = await sb
      .from("holdings")
      .select("*")
      .order("added_at", { ascending: false });
    if (error) throw error;

    const items = (rows ?? []).map((row) => ({
      ...row,
      latestSellProbability: row.latest_sell_probability,
      latestSellAt: row.latest_sell_at,
      entryPrice: row.entry_price,
      lastPrice: row.last_price,
      latestSellTag: row.latest_sell_tag,
      judgments: [] as unknown[],
    }));

    return NextResponse.json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "holdings get error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      code?: string;
      quantity?: number;
      entryPrice?: number | null;
    };
    const code = normalizeCode(body.code ?? "");
    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return NextResponse.json({ error: "数量须为正整数" }, { status: 400 });
    }
    let entryPrice = null as number | null;
    if (body.entryPrice != null && body.entryPrice !== ("" as unknown)) {
      const n = Number(body.entryPrice);
      if (!Number.isFinite(n) || n <= 0) {
        return NextResponse.json({ error: "成本价须为正数" }, { status: 400 });
      }
      entryPrice = n;
    }
    const stock = await resolveStock(code);
    if (entryPrice == null && stock.price > 0) entryPrice = stock.price;
    const sb = getSupabase();
    const { data, error } = await sb
      .from("holdings")
      .upsert(
        {
          market: stock.market,
          code: stock.code,
          name: stock.name,
          quantity,
          entry_price: entryPrice,
        },
        { onConflict: "market,code" }
      )
      .select("*")
      .single();
    if (error) throw error;
    return NextResponse.json({ item: data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "holdings add error";
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
    const { error } = await sb.from("holdings").delete().eq("id", Number(id));
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "holdings delete error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
