export const runWithConcurrency = async <T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> => {
  let index = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      await fn(current);
    }
  });
  await Promise.all(workers);
};
