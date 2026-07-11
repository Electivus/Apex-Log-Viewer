import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parseApexLogIds } from '@alv/core';

export async function resolveLogIds(
  values: string[] | undefined,
  idsFile: string | undefined
): Promise<string[] | undefined> {
  if (values?.length && idsFile) throw new Error('--log-id and --ids-file are mutually exclusive.');
  if (values?.length) {
    const ids = parseApexLogIds(values.join(','));
    if (ids.length === 0) throw new Error('No valid ApexLog ids were found in --log-id.');
    return ids;
  }
  if (!idsFile) return undefined;
  const ids = parseApexLogIds(await fs.readFile(path.resolve(idsFile), 'utf8'));
  if (ids.length === 0) throw new Error(`No valid ApexLog ids were found in --ids-file: ${idsFile}`);
  return ids;
}
