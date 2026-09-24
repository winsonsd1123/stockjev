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
