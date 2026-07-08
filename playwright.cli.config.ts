import path from 'path';
import { defineConfig } from '@playwright/test';
import { resolvePlaywrightParallelism, resolvePlaywrightTimeouts } from './test/e2e/utils/playwrightParallelism';
import { applyE2eNetworkEnvironment } from './test/e2e/utils/proxy';

applyE2eNetworkEnvironment();

const repoRoot = __dirname;
const artifactsRoot = path.join(repoRoot, 'output', 'playwright-cli');
const resultsRoot = path.join(artifactsRoot, 'test-results');
const parallelism = resolvePlaywrightParallelism();
const timeouts = resolvePlaywrightTimeouts();

export default defineConfig({
  testDir: path.join(__dirname, 'test', 'e2e', 'cli'),
  fullyParallel: parallelism.fullyParallel,
  workers: parallelism.workers,
  timeout: timeouts.testTimeoutMs,
  expect: { timeout: timeouts.expectTimeoutMs },
  retries: process.env.CI ? 1 : 0,
  outputDir: resultsRoot,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: path.join(artifactsRoot, 'report') }]]
    : [['list']],
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
});
