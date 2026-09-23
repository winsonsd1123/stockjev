/**
 * 交易时段判定（纯函数版）。
 * isTradingDay：上证当日 K 线是否有数据（由调用方注入，避免纯函数依赖网络）。
 * now：Asia/Shanghai 本地墙钟时间。
 */
export function isTradingSession(
  isTradingDay: boolean,
  now: Date = new Date()
): boolean {
  if (!isTradingDay) return false;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const mins = hour * 60 + minute;

  const morning = mins >= 9 * 60 + 30 && mins < 11 * 60 + 30;
  const afternoon = mins >= 13 * 60 && mins < 15 * 60;
  return morning || afternoon;
}

export function shanghaiYmd(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
