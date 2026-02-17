import path from 'path';
import { defineConfig } from '@playwright/test';

const repoRoot = path.join(__dirname, '..', '..');
const artifactsRoot = path.join(repoRoot, 'output', 'playwright');

export default defineConfig({
  testDir: path.join(__dirname, 'test', 'e2e', 'specs'),
  fullyParallel: false,
  workers: 1,
  timeout: 15 * 60 * 1000,
  expect: { timeout: 60 * 1000 },
  retries: process.env.CI ? 1 : 0,
  outputDir: artifactsRoot,
  reporter: process.env.CI
    ? [
        ['list'],
        ['html', { open: 'never', outputFolder: path.join(artifactsRoot, 'report') }]
      ]
    : [['list']],
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
});

