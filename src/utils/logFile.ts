import { promises as fs } from 'fs';
import { fetchApexLogBody } from '../salesforce/http';
import type { OrgAuth } from '../salesforce/types';
import { getLogFilePathWithUsername, findExistingLogFile } from './workspace';

export async function ensureLogFile(auth: OrgAuth, logId: string, signal?: AbortSignal): Promise<string> {
  const existing = await findExistingLogFile(logId);
  if (existing) {
    return existing;
  }
  const { filePath } = await getLogFilePathWithUsername(auth.username, logId);
  const body = await fetchApexLogBody(auth, logId, undefined, signal);
  await fs.writeFile(filePath, body, 'utf8');
  return filePath;
}

