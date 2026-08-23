export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function runOne(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }

  const poolSize = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: poolSize }, () => runOne()));
  return results;
}
