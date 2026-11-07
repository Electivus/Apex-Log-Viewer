import type { RipgrepMatch } from './ripgrep';

export function buildLogSearchSnippet(match: RipgrepMatch): { text: string; ranges: [number, number][] } | undefined {
  const rawLine = typeof match.lineText === 'string' ? match.lineText : '';
  const line = rawLine.replace(/\r?\n$/, '');
  if (!line) {
    return undefined;
  }
  const rawRanges = Array.isArray(match.submatches) ? match.submatches : [];
  const charRanges = rawRanges
    .map(({ start, end }) => {
      const charStart = byteOffsetToStringIndex(line, start ?? 0);
      const charEnd = byteOffsetToStringIndex(line, end ?? 0);
      return [charStart, Math.max(charStart, charEnd)] as [number, number];
    })
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start);

  const context = 60;
  const earliest = charRanges.length > 0 ? Math.min(...charRanges.map(r => r[0])) : 0;
  const latest =
    charRanges.length > 0 ? Math.max(...charRanges.map(r => r[1])) : Math.min(line.length, earliest + context);
  const sliceStart = Math.max(0, earliest - context);
  const sliceEnd = Math.min(line.length, latest + context);
  const core = line.slice(sliceStart, sliceEnd);
  const prefix = sliceStart > 0 ? '...' : '';
  const suffix = sliceEnd < line.length ? '...' : '';
  const prefixLength = prefix.length;
  const snippetLength = core.length + prefixLength + suffix.length;
  const adjustedRanges = charRanges
    .map(([start, end]) => {
      const adjustedStart = Math.max(0, start - sliceStart) + prefixLength;
      const adjustedEnd = Math.max(adjustedStart, Math.min(core.length, end - sliceStart) + prefixLength);
      return [adjustedStart, Math.max(adjustedStart, adjustedEnd)] as [number, number];
    })
    .filter(([start, end]) => end > start);

  const finalSnippet = `${prefix}${core}${suffix}`;
  const boundedRanges = adjustedRanges.map(([start, end]) => {
    const boundedStart = Math.max(0, Math.min(start, snippetLength));
    const boundedEnd = Math.max(0, Math.min(end, snippetLength));
    return [boundedStart, Math.max(boundedStart, boundedEnd)] as [number, number];
  });

  return {
    text: finalSnippet,
    ranges: boundedRanges
  };
}

function byteOffsetToStringIndex(text: string, byteOffset: number): number {
  if (!text || !Number.isFinite(byteOffset) || byteOffset <= 0) {
    return 0;
  }
  let byteTally = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const codeUnitLength = codePoint > 0xffff ? 2 : 1;
    const utf8Length = utf8ByteLength(codePoint);
    if (byteTally + utf8Length > byteOffset) {
      break;
    }
    byteTally += utf8Length;
    index += codeUnitLength;
  }
  return index;
}

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}
