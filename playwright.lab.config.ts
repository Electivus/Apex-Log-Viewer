import path from 'path';
import { defineConfig } from '@playwright/test';
import { applyE2eNetworkEnvironment } from './test/e2e/utils/proxy';

applyE2eNetworkEnvironment();

const artifactsRoot = path.join(__dirname, 'output', 'lab', 'playwright');

export default defineConfig({
  testDir: path.join(__dirname, 'test', 'e2e', 'lab'),
  testMatch: '**/*.lab.spec.ts',
  workers: 1,
  timeout: 30 * 60_000,
  retries: 0,
  outputDir: path.join(artifactsRoot, 'test-results'),
  reporter: [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' }
});
