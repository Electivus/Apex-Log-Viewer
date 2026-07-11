export type QueryLengthBucket = '0' | '1-3' | '4-10' | '11-30' | '31+';

export function bucketQueryLength(value: string | number | null | undefined): QueryLengthBucket {
  const length = typeof value === 'number' ? value : String(value ?? '').trim().length;
  if (length <= 0) {
    return '0';
  }
  if (length <= 3) {
    return '1-3';
  }
  if (length <= 10) {
    return '4-10';
  }
  if (length <= 30) {
    return '11-30';
  }
  return '31+';
}
