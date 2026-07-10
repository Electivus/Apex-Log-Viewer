import { promises as fs } from 'node:fs';
import {
  createUnreadableLogTriageSummary,
  normalizeLogTriageSummary,
  type LogTriageSummary
} from '../../apps/vscode-extension/src/shared/logTriage';

type LogTriageAnalyzerModule = {
  summarizeLogText(logText: string): unknown;
};

const analyzer = require('../../packages/sf-plugin/src/logTriage') as LogTriageAnalyzerModule;

export function createUnreadableLogSummary(message?: string): LogTriageSummary {
  return createUnreadableLogTriageSummary(message);
}

export async function summarizeLogText(logText: string): Promise<LogTriageSummary> {
  return normalizeLogTriageSummary(analyzer.summarizeLogText(logText));
}

export async function summarizeLogFile(filePath: string): Promise<LogTriageSummary> {
  return summarizeLogText(await fs.readFile(filePath, 'utf8'));
}
