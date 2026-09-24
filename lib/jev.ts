export const JEV_MODEL = "~typesafe/jev-latest";

/**
 * 发现题有序量规。Jev score 最多 10 档（下标 0..9）。
 * 展示分 = round(index * 100 / 9)，即 0→0 … 9→100。
 */
export const EXCELLENCE_CRITERIA = [
  "0 数据缺失，或 maAlign=bear 且 ret20<-0.20 且 volRatio5_20>1.5（放量破位）",
  "1 明显透支：ret20>0.40 且 pos20>0.9，或 limitUpCount20>=2，或 bias20>0.15。涨幅大不是加分",
  "2 过热：ret20>0.30 或 bias20>0.12 或（pos20>0.92 且 ret5>0.10）",
  "3 趋势偏空但未崩：maAlign=bear，ddFromHigh60>-0.25，volRatio5_20<0.8（缩量回落，未确认）",
  "4 偏弱：maAlign=bear 或（ret60<0 且 rs60<0），无放量破位",
  "5 中性：maAlign=mixed，无连续涨停、无极端乖离",
  "6 略好：maAlign=bull 或 rs60>0，但 ret60 不在 0.05~0.40 或 pos20 偏离 0.35~0.8",
  "7 较好：接近优秀，仅一项轻度越界（bias20 在 0.06~0.10，或 pos20 在 0.8~0.9）",
  "8 优秀：maAlign=bull，ret60 在 0.05~0.40，bias20 在 -0.03~0.08，pos20 在 0.35~0.85，limitUpCount20=0，vol20Ann<0.50，rs60>0",
  "9 顶尖观察候选：maAlign=bull，ret60 在 0.05~0.40，bias20 在 -0.03~0.06，pos20 在 0.35~0.8，limitUpCount20=0，volRatio5_20 在 0.7~1.4，vol20Ann<0.45，rs60>0。涨幅大、连板、高乖离不是加分",
] as const;

export type NoulAnswer = {
  type: "noul";
  noul: number;
};

export type ScoreAnswer = {
  type: "score";
  score: number;
  confidence?: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
};

export type DecisionsResponse = {
  answers: Record<string, NoulAnswer | ScoreAnswer | { type: string }>;
  id?: string;
  model?: string;
  usage?: { cost?: number; input_tokens?: number; output_tokens?: number };
};

/** score 下标(0..9) → 0-100 展示分 */
export function scoreIndexToDisplay(scoreIndex: number): number {
  return Math.round((scoreIndex * 100) / 9);
}

/** score 下标 → judgments.probability (0-1) */
export function scoreIndexToProbability(scoreIndex: number): number {
  return scoreIndexToDisplay(scoreIndex) / 100;
}

export function parseNoul(
  response: DecisionsResponse,
  key: string
): { probability: number; details: Record<string, unknown> } {
  const answer = response.answers[key];
  if (!answer || answer.type !== "noul" || typeof (answer as NoulAnswer).noul !== "number") {
    throw new Error(`缺少 noul 答案: ${key}`);
  }
  const noul = (answer as NoulAnswer).noul;
  return {
    probability: noul,
    details: { noul, type: "noul" },
  };
}

export function parseScore(
  response: DecisionsResponse,
  key: string
): {
  displayScore: number;
  probability: number;
  details: Record<string, unknown>;
} {
  const answer = response.answers[key];
  if (!answer || answer.type !== "score" || typeof (answer as ScoreAnswer).score !== "number") {
    throw new Error(`缺少 score 答案: ${key}`);
  }
  const a = answer as ScoreAnswer;
  return {
    displayScore: scoreIndexToDisplay(a.score),
    probability: scoreIndexToProbability(a.score),
    details: {
      type: "score",
      score: a.score,
      confidence: a.confidence,
      legend: a.legend,
      probabilities: a.probabilities,
      displayScore: scoreIndexToDisplay(a.score),
    },
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function parseNouls(
  response: DecisionsResponse,
  keys: string[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of keys) {
    out[key] = parseNoul(response, key).probability;
  }
  return out;
}

export function buildExcellenceQuestion() {
  return {
    excellence: {
      type: "score" as const,
      instructions:
        "基于 `features` 判断该股作为「等待合适买点的观察候选」的质量。涨跌幅字段是小数（0.10=10%）。近期涨幅大、连续涨停、乖离率高属于风险而不是优点；近期跌幅大也不是优点，除非缩量且趋势结构未破。对照 criteria 从低到高选最贴合的一档。",
      criteria: [...EXCELLENCE_CRITERIA],
    },
    overextended: {
      type: "noul" as const,
      instructions: "该股当前是否已经透支、处于追高风险区",
      criteria: {
        true: "ret20>0.30 或 bias20>0.12 或 limitUpCount20>=2 或（pos20>0.92 且 ret5>0.10）",
        false: "未出现上述透支情形",
      },
    },
    trendHealthy: {
      type: "noul" as const,
      instructions: "该股趋势结构是否健康",
      criteria: {
        true: "maAlign=bull 且 rs60>0 且 vol20Ann<0.50",
        false: "不满足 maAlign=bull 且 rs60>0 且 vol20Ann<0.50",
      },
    },
  };
}

export function buildIndexQuestion() {
  return {
    indexOk: {
      type: "noul" as const,
      instructions:
        "基于 `index` 判断上证当前是否允许做个股买入。涨跌幅是小数。",
      criteria: {
        true: "intradayRet>-0.01 且 ret5>-0.03 且 price>=vwap（未跌破日内均价）",
        false: "intradayRet<=-0.01 或 ret5<=-0.03 或 price<vwap",
      },
    },
  };
}

export type BuyParts = {
  chaseRisk: number;
  strongerThanIndex: number;
  validBreakout: number;
  pullbackEntry: number;
};

export function composeBuy(parts: BuyParts, indexOk: number): number {
  return clamp01(
    (1 - parts.chaseRisk) *
      Math.max(parts.validBreakout, parts.pullbackEntry) *
      (0.4 + 0.6 * parts.strongerThanIndex) *
      (0.5 + 0.5 * indexOk)
  );
}

export type SellParts = {
  trendBroken: number;
  takeProfit: number;
  dipIsMarketDriven: number;
};

export function composeSell(parts: SellParts): number {
  return clamp01(
    0.6 * parts.trendBroken +
      0.5 * parts.takeProfit -
      0.4 * parts.dipIsMarketDriven
  );
}

export function buildBuyQuestions() {
  return {
    chaseRisk: {
      type: "noul" as const,
      instructions: "当前买入是否属于追高。涨跌幅字段是小数（0.07=7%）。",
      criteria: {
        true: "changePct>0.07 或 distToLimitUpPct<0.02 或 gapUpToday>0.03 或 ret5>0.15 或 bias20>0.12 或 vwapDevPct>0.03 或（posInDayRange>0.95 且 ampToday>0.06）",
        false: "未出现上述追高情形",
      },
    },
    strongerThanIndex: {
      type: "noul" as const,
      instructions: "个股分时是否强于大盘且站上均价",
      criteria: {
        true: "rsIntraday>0 且 price>vwap 且 rs5>=0",
        false: "rsIntraday<=0 或 price<=vwap 或 rs5<0",
      },
    },
    validBreakout: {
      type: "noul" as const,
      instructions: "当前是否为有效放量突破，而不是异常脉冲",
      criteria: {
        true: "breakout20=true 且 volRatioNow 在 1.5~5 且 price>=vwap 且 posInDayRange>0.6，且 ampToday<=0.08",
        false: "未突破，或量比不在 1.5~5，或 price<vwap，或 ampToday>0.08",
      },
    },
    pullbackEntry: {
      type: "noul" as const,
      instructions: "当前是否为趋势中的回踩企稳买点",
      criteria: {
        true: "maAlign=bull 且 bias20 在 -0.05~0.02 且 changePct 在 -0.03~0.02 且 price>=vwap 且 rsIntraday>=-0.005",
        false: "不满足回踩企稳条件",
      },
    },
  };
}

export function buildSellQuestions() {
  return {
    trendBroken: {
      type: "noul" as const,
      instructions: "持仓是否已经放量破位。涨跌幅是小数。",
      criteria: {
        true: "belowMA20 且 volRatioNow>1.3 且 rsIntraday<-0.01，或（ddFromHigh60<-0.15 且 maAlign=bear）",
        false: "未放量破位，趋势结构未坏",
      },
    },
    takeProfit: {
      type: "noul" as const,
      instructions: "当前是否出现止盈信号，而不是单纯下跌",
      criteria: {
        true: "（pnlPct>0.15 且 giveBackRatio>0.3）或 bias20>0.15 或（limitUpCount20>=2 且 posInDayRange<0.3 且 ampToday>0.07）或（pnlPct>0.08 且 ddFromPeakPct<-0.06）",
        false: "未出现上述止盈情形",
      },
    },
    dipIsMarketDriven: {
      type: "noul" as const,
      instructions: "当前下跌是否只是跟随大盘，个股结构未破，因而不应杀跌",
      criteria: {
        true: "changePct<-0.02 且 rsIntraday>=0 且 price>=vwap*0.99 且 belowMA20=false",
        false: "下跌不是单纯跟随大盘，或已跌破 MA20",
      },
    },
  };
}
