import { createHash } from 'node:crypto';

/** Deterministic JSON: object keys sorted, so equal values hash equally whatever their key order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter(key => record[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Twelve hex characters of a SHA-1 over the stable JSON of `value`: a fingerprint, not a secret. */
export function shortHash(value: unknown): string {
  return createHash('sha1').update(stableStringify(value)).digest('hex').slice(0, 12);
}
