import { promises as fs } from 'node:fs';
import { summarizeLogText as summarizeCoreLogText } from '@alv/core';
import {
  createUnreadableLogTriageSummary,
  normalizeLogTriageSummary,
  type LogTriageSummary
} from '../../shared/logTriage';

export function createUnreadableLogSummary(message?: string): LogTriageSummary {
  return createUnreadableLogTriageSummary(message);
}

export async function summarizeLogText(logText: string): Promise<LogTriageSummary> {
  return normalizeLogTriageSummary(summarizeCoreLogText(logText));
}

export async function summarizeLogFile(filePath: string): Promise<LogTriageSummary> {
  return summarizeLogText(await fs.readFile(filePath, 'utf8'));
}
