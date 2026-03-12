import { rm } from 'node:fs/promises';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableCleanupError(error: unknown): boolean {
  const code = String((error as NodeJS.ErrnoException | undefined)?.code || '').toUpperCase();
  return code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EPERM';
}

export async function removePathBestEffort(
  targetPath: string,
  options: { attempts?: number; delayMs?: number } = {}
): Promise<void> {
  const attempts = Math.max(1, options.attempts ?? 8);
  const delayMs = Math.max(50, options.delayMs ?? 250);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetryableCleanupError(error) || attempt === attempts) {
        console.warn(
          `[e2e] Failed to remove temporary path '${targetPath}': ${error instanceof Error ? error.message : String(error)}`
        );
        return;
      }
      await sleep(delayMs * attempt);
    }
  }
}
