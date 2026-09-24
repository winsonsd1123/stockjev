import { fetchEastmoneyPage, fetchSinaPage } from "../lib/eastmoney";
import { shouldScore } from "../lib/filter";
import type { MarketSnapshot } from "../lib/eastmoney";

function tally(items: MarketSnapshot[], label: string) {
  const reasons: Record<string, number> = { ok: 0 };
  for (const s of items) {
    const g = shouldScore(s);
    if (g.ok) reasons.ok++;
    else reasons[g.reason] = (reasons[g.reason] || 0) + 1;
  }
  console.log(label, "n=" + items.length, reasons);
  console.log(
    "sample",
    items.slice(0, 5).map((s) => ({
      code: s.code,
      name: s.name,
      price: s.price,
      volume: s.volume,
      amount: s.amount,
      listDate: s.listDate,
    }))
  );
}

async function main() {
  try {
    const em = await fetchEastmoneyPage(1, 100);
    tally(em.items, "eastmoney p1");
  } catch (e) {
    console.log("eastmoney fail", e instanceof Error ? e.message : e);
  }
  try {
    const sina = await fetchSinaPage("hs_a", 1);
    tally(sina, "sina hs_a p1");
  } catch (e) {
    console.log("sina fail", e instanceof Error ? e.message : e);
  }
}

main();
