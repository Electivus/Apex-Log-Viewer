import path from 'path';
import { defineConfig } from '@playwright/test';

const repoRoot = __dirname;
const artifactsRoot = path.join(repoRoot, 'output', 'playwright', 'docs');
const resultsRoot = path.join(artifactsRoot, 'test-results');

export default defineConfig({
  testDir: path.join(__dirname, 'test', 'e2e', 'docs'),
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 30 * 60 * 1000,
  expect: { timeout: 60 * 1000 },
  retries: 0,
  outputDir: resultsRoot,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
});
