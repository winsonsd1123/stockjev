export const JEV_MODEL = "~typesafe/jev-latest";

/**
 * 发现题有序量规。Jev score 最多 10 档（下标 0..9）。
 * 展示分 = round(index * 100 / 9)，即 0→0 … 9→100。
 */
export const EXCELLENCE_CRITERIA = [
  "0 分 — 极差，无观察价值",
  "约 11 分 — 很差",
  "约 22 分 — 较差",
  "约 33 分 — 偏弱",
  "约 44 分 — 略低于平均",
  "约 56 分 — 略好于平均",
  "约 67 分 — 较好",
  "约 78 分 — 优秀",
  "约 89 分 — 非常优秀",
  "100 分 — 顶尖，强烈值得纳入观察池",
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

export function buildExcellenceQuestion() {
  return {
    excellence: {
      type: "score" as const,
      instructions: "综合快照指标与近一周日K线，评估该股作为观察池候选的优秀度",
      criteria: [...EXCELLENCE_CRITERIA],
    },
  };
}

export function buildBuyQuestion() {
  return {
    buy: {
      type: "noul" as const,
      instructions: "结合大盘背景与个股分时数据，当前是否适合立即买入",
      criteria: {
        true: "分时与大盘背景显示当前适合立即买入",
        false: "分时与大盘背景显示当前不适合立即买入",
      },
    },
  };
}

export function buildSellQuestion() {
  return {
    sell: {
      type: "noul" as const,
      instructions: "结合大盘背景与个股分时数据，当前是否适合立即卖出",
      criteria: {
        true: "分时与大盘背景显示当前适合立即卖出",
        false: "分时与大盘背景显示当前不适合立即卖出",
      },
    },
  };
}
