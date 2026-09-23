/** 将数组按固定大小切批 */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("batch size must be > 0");
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

/** 从 cursor 起取下一批 */
export function nextBatch<T>(
  items: T[],
  cursor: number,
  size: number
): { batch: T[]; nextCursor: number; done: boolean } {
  const batch = items.slice(cursor, cursor + size);
  const nextCursor = cursor + batch.length;
  return {
    batch,
    nextCursor,
    done: nextCursor >= items.length,
  };
}
