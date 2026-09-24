export type GateDecision = {
  /** skip：本轮不写概率；force：不调 Jev；continue：调 Jev 后套 cap */
  action: "skip" | "force" | "continue";
  probability?: number;
  /** 0-1，合成概率不得超过此值 */
  cap?: number;
  tag?: string;
};

export function discoverCap(features: {
  ret20: number | null;
  pos20: number | null;
  limitUpCount20: number;
  bias20: number | null;
}): { cap: number | null; tag: string | null } {
  const hits: { cap: number; tag: string }[] = [];
  if (
    features.ret20 != null &&
    features.pos20 != null &&
    features.ret20 > 0.4 &&
    features.pos20 > 0.9
  ) {
    hits.push({ cap: 44, tag: "20日涨幅过大且贴近高点" });
  }
  if (features.limitUpCount20 >= 3) {
    hits.push({ cap: 33, tag: "20日内涨停过多" });
  }
  if (features.bias20 != null && features.bias20 > 0.2) {
    hits.push({ cap: 33, tag: "乖离率过高" });
  }
  if (hits.length === 0) return { cap: null, tag: null };
  return {
    cap: Math.min(...hits.map((h) => h.cap)),
    tag: hits.map((h) => h.tag).join("；"),
  };
}

export function buyGate(input: {
  isLimitUp: boolean;
  isOneWordBoard: boolean;
  isLimitDown: boolean;
  barsCount: number;
  afterCloseAuction: boolean;
  ret20: number | null;
  pos20: number | null;
  limitUpCount20: number;
  changePct: number | null;
  /** 20% 或 30% 板 */
  wideLimit: boolean;
}): GateDecision {
  if (input.afterCloseAuction) {
    return { action: "skip", tag: "尾盘集合竞价" };
  }
  if (input.barsCount < 3) {
    return { action: "skip", tag: "开盘样本不足" };
  }
  if (input.isLimitUp || input.isOneWordBoard) {
    return { action: "force", probability: 0, tag: "涨停不可买" };
  }
  if (input.isLimitDown) {
    return { action: "force", probability: 0, tag: "跌停" };
  }

  let cap: number | undefined;
  const tags: string[] = [];
  const overextended =
    (input.ret20 != null &&
      input.pos20 != null &&
      input.ret20 > 0.4 &&
      input.pos20 > 0.9) ||
    input.limitUpCount20 >= 2;
  if (overextended) {
    cap = 0.3;
    tags.push("透支降档");
  }
  const chaseLine = input.wideLimit ? 0.15 : 0.08;
  if (input.changePct != null && input.changePct > chaseLine) {
    cap = cap == null ? 0.2 : Math.min(cap, 0.2);
    tags.push("当日涨幅过大");
  }
  return {
    action: "continue",
    cap,
    tag: tags.length > 0 ? tags.join("；") : undefined,
  };
}

export function sellGate(input: {
  isLimitUp: boolean;
  isLimitDown: boolean;
  boughtToday: boolean;
  afterCloseAuction: boolean;
  barsCount: number;
  pnlPct: number | null;
  belowAtrStop: boolean;
}): GateDecision {
  if (input.afterCloseAuction) {
    return { action: "skip", tag: "尾盘集合竞价" };
  }
  if (input.barsCount < 3) {
    return { action: "skip", tag: "开盘样本不足" };
  }
  if (input.boughtToday) {
    return { action: "skip", tag: "T+1 不可卖" };
  }
  if (input.isLimitDown) {
    return { action: "force", probability: 1, tag: "跌停封板无法卖出" };
  }
  if (
    (input.pnlPct != null && input.pnlPct < -0.08) ||
    input.belowAtrStop
  ) {
    return { action: "force", probability: 1, tag: "硬止损" };
  }
  if (input.isLimitUp) {
    return { action: "continue", cap: 0.2, tag: "涨停中" };
  }
  return { action: "continue" };
}

export function applyCap(probability: number, cap?: number): number {
  if (cap == null) return probability;
  return Math.min(probability, cap);
}

export const SYSTEM_POOL_CAP = 10;
export const TREND_BROKEN_TAG = "趋势已破";

export type PoolAlign = "bull" | "bear" | "mixed";

export type PoolMember = {
  id: number;
  market: string;
  code: string;
  starred: boolean;
  bearStreak: number;
  score: number | null;
};

export type PoolSuggestion = {
  market: string;
  code: string;
  name: string;
  score: number;
  maAlign: PoolAlign;
  capped: boolean;
};

export type SuggestionStatus =
  | "已标星"
  | "已在系统池"
  | "待第二轮"
  | "本轮可补入"
  | "系统池已满";

export type ReconcileResult = {
  removeIds: number[];
  scoreUpdates: { id: number; score: number }[];
  trendUpdates: { id: number; bearStreak: number; trendTag: string | null }[];
  inserts: { market: string; code: string; name: string; score: number }[];
  statuses: { market: string; code: string; status: SuggestionStatus }[];
};

function poolKey(market: string, code: string): string {
  return `${market}:${code}`;
}

/** 系统池：健康不替换；无星连续两次 bear 移出；空位只补连续两轮且多头、未封顶的建议。 */
export function reconcilePool(input: {
  pool: PoolMember[];
  trends: { id: number; maAlign: PoolAlign }[];
  suggestions: PoolSuggestion[];
  previousCodes: string[];
}): ReconcileResult {
  const trendById = new Map(input.trends.map((t) => [t.id, t.maAlign]));
  const removeIds: number[] = [];
  const trendUpdates: ReconcileResult["trendUpdates"] = [];

  for (const row of input.pool) {
    const align = trendById.get(row.id);
    if (align == null) continue;
    if (row.starred) {
      trendUpdates.push({
        id: row.id,
        bearStreak: row.bearStreak,
        trendTag: align === "bear" ? TREND_BROKEN_TAG : null,
      });
      continue;
    }
    if (align === "bear") {
      const streak = row.bearStreak + 1;
      if (streak >= 2) removeIds.push(row.id);
      else trendUpdates.push({ id: row.id, bearStreak: streak, trendTag: null });
    } else {
      trendUpdates.push({ id: row.id, bearStreak: 0, trendTag: null });
    }
  }

  const removed = new Set(removeIds);
  const scoreByKey = new Map(
    input.suggestions.map((s) => [poolKey(s.market, s.code), s.score])
  );
  const scoreUpdates: ReconcileResult["scoreUpdates"] = [];
  for (const row of input.pool) {
    if (removed.has(row.id)) continue;
    const score = scoreByKey.get(poolKey(row.market, row.code));
    if (score == null) continue;
    scoreUpdates.push({ id: row.id, score });
  }

  const alive = input.pool.filter((row) => !removed.has(row.id));
  const aliveKeys = new Set(alive.map((row) => poolKey(row.market, row.code)));
  let vacancies = Math.max(
    0,
    SYSTEM_POOL_CAP - alive.filter((row) => !row.starred).length
  );
  const prev = new Set(input.previousCodes);
  const inserts: ReconcileResult["inserts"] = [];
  for (const s of input.suggestions) {
    if (vacancies <= 0) break;
    const key = poolKey(s.market, s.code);
    if (aliveKeys.has(key) || !prev.has(key)) continue;
    if (s.maAlign !== "bull" || s.capped) continue;
    inserts.push({
      market: s.market,
      code: s.code,
      name: s.name,
      score: s.score,
    });
    aliveKeys.add(key);
    vacancies -= 1;
  }

  const insertKeys = new Set(inserts.map((row) => poolKey(row.market, row.code)));
  const starredKeys = new Set(
    alive.filter((row) => row.starred).map((row) => poolKey(row.market, row.code))
  );
  const systemKeys = new Set(
    alive.filter((row) => !row.starred).map((row) => poolKey(row.market, row.code))
  );
  const systemAfter =
    alive.filter((row) => !row.starred).length + inserts.length;
  const statuses = input.suggestions.map((s) => {
    const key = poolKey(s.market, s.code);
    let status: SuggestionStatus;
    if (starredKeys.has(key)) status = "已标星";
    else if (insertKeys.has(key)) status = "本轮可补入";
    else if (systemKeys.has(key)) status = "已在系统池";
    else if (!prev.has(key) || s.maAlign !== "bull" || s.capped) status = "待第二轮";
    else if (systemAfter >= SYSTEM_POOL_CAP) status = "系统池已满";
    else status = "待第二轮";
    return { market: s.market, code: s.code, status };
  });

  return { removeIds, scoreUpdates, trendUpdates, inserts, statuses };
}
