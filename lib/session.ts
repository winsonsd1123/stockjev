/**
 * 交易时段：交易日 Asia/Shanghai 9:30–15:00（含午休）。
 * isTradingDay 由调用方注入（上证当日是否有 K 线）。
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

  return mins >= 9 * 60 + 30 && mins < 15 * 60;
}

export function shanghaiMinutes(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/** 已开盘分钟 / 240。午休按上午已满 120 分钟计。 */
export function sessionProgress(now: Date = new Date()): number {
  const mins = shanghaiMinutes(now);
  let elapsed = 0;
  if (mins < 9 * 60 + 30) elapsed = 0;
  else if (mins <= 11 * 60 + 30) elapsed = mins - (9 * 60 + 30);
  else if (mins < 13 * 60) elapsed = 120;
  else if (mins <= 15 * 60) elapsed = 120 + (mins - 13 * 60);
  else elapsed = 240;
  return elapsed / 240;
}

export function isLateSession(now: Date = new Date()): boolean {
  return shanghaiMinutes(now) >= 14 * 60 + 57;
}

export function shanghaiYmd(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
