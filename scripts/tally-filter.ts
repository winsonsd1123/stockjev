import { getMarketData, type MarketSnapshot } from "../lib/market-data";
import { shouldScore } from "../lib/filter";

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
    const page = await getMarketData().fetchSnapshotPage(1, 100);
    tally(page.items, "biying p1");
  } catch (e) {
    console.log("biying fail", e instanceof Error ? e.message : e);
  }
}

main();
