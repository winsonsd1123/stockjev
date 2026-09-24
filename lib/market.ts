export type Market = "sh" | "sz" | "bj";

/** 根据 6 位 A 股代码推断市场 */
export function codeToMarket(code: string): Market {
  if (!/^\d{6}$/.test(code)) {
    throw new Error(`无效股票代码: ${code}`);
  }
  if (code.startsWith("60") || code.startsWith("68")) return "sh";
  if (code.startsWith("00") || code.startsWith("30")) return "sz";
  if (
    code.startsWith("43") ||
    code.startsWith("83") ||
    code.startsWith("87") ||
    code.startsWith("92")
  ) {
    return "bj";
  }
  // 默认深市（含部分北交所映射到 f13=0）
  return "sz";
}

/** 东财 secid：沪市 1.xxxxxx，深/北 0.xxxxxx */
export function toSecid(market: Market, code: string): string {
  const prefix = market === "sh" ? "1" : "0";
  return `${prefix}.${code}`;
}

export function normalizeCode(input: string): string {
  const code = input.trim();
  if (!/^\d{6}$/.test(code)) {
    throw new Error("股票代码须为 6 位数字");
  }
  return code;
}

/** 涨跌幅限制：创业板/科创板 20%，北交所 30%，其余 10% */
export function limitPct(market: Market, code: string): number {
  if (code.startsWith("30") || code.startsWith("68")) return 0.2;
  if (market === "bj") return 0.3;
  return 0.1;
}

/** 由昨收和板别比例得到涨停价、跌停价（四舍五入到分） */
export function limitPrices(
  prevClose: number,
  pct: number
): { up: number; down: number } {
  return {
    up: Math.round(prevClose * (1 + pct) * 100) / 100,
    down: Math.round(prevClose * (1 - pct) * 100) / 100,
  };
}
