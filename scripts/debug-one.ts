import {
  buildExcellenceQuestion,
  parseScore,
} from "../lib/jev";

async function main() {
  const market = "sz";
  const code = "300308";
  const symbol = market + code;
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,5,qfq`;
  const kRes = await fetch(url);
  const kJson = (await kRes.json()) as {
    data?: Record<string, { qfqday?: string[][]; day?: string[][] }>;
  };
  const rows = kJson.data?.[symbol]?.qfqday ?? kJson.data?.[symbol]?.day ?? [];
  console.log("klines", rows.length, "criteria", 10);

  const state = {
    snapshot: {
      name: "中际旭创",
      market,
      code,
      marketCap: 0,
      pe: 0,
      pb: 0,
      turnover: 0,
      volumeRatio: 0,
      changePct: -0.5,
      amount: 1e10,
    },
    dailyKlines: rows.map((r) => ({
      date: r[0],
      open: +r[1],
      close: +r[2],
      high: +r[3],
      low: +r[4],
      volume: +r[5],
      amount: 0,
    })),
  };

  const res = await fetch("https://openrouter.ai/api/alpha/decisions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "~typesafe/jev-latest",
      state,
      questions: buildExcellenceQuestion(),
    }),
  });
  const json = await res.json();
  console.log("jev", res.status, JSON.stringify(json).slice(0, 500));
  if (res.ok) console.log("parsed", parseScore(json, "excellence"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
