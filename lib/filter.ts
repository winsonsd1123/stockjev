export type SnapshotLike = {
  name: string;
  /** 成交额（元） */
  amount: number;
  /** 上市日 YYYYMMDD 或 null */
  listDate: number | null;
};

const MIN_AMOUNT = 50_000_000; // 5000 万
const MIN_LIST_DAYS = 60;

function daysSinceList(listDate: number, today: Date): number {
  const s = String(listDate);
  if (s.length !== 8) return 0;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const listed = new Date(y, m - 1, d);
  const ms = today.getTime() - listed.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/** 粗筛：剔除 ST、上市不足 60 天、成交额过低 */
export function passesCoarseFilter(
  snap: SnapshotLike,
  today: Date = new Date()
): boolean {
  const name = snap.name ?? "";
  if (/ST/i.test(name)) return false;
  if (snap.amount < MIN_AMOUNT) return false;
  if (snap.listDate != null && daysSinceList(snap.listDate, today) < MIN_LIST_DAYS) {
    return false;
  }
  return true;
}

export function filterCandidates<T extends SnapshotLike>(
  items: T[],
  today: Date = new Date()
): T[] {
  return items.filter((item) => passesCoarseFilter(item, today));
}
