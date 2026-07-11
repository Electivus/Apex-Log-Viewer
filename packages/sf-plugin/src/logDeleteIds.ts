import { promises as fs } from 'node:fs';
import path from 'node:path';

function parseIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/u)
        .map(item => item.trim())
        .filter(Boolean)
    )
  ];
}

export async function resolveLogIds(
  values: string[] | undefined,
  idsFile: string | undefined
): Promise<string[] | undefined> {
  if (values?.length && idsFile) throw new Error('--log-id and --ids-file are mutually exclusive.');
  if (values?.length) return [...new Set(values.flatMap(parseIds))];
  if (!idsFile) return undefined;
  return parseIds(await fs.readFile(path.resolve(idsFile), 'utf8'));
}
