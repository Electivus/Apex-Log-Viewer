export type SnippetRanges = [number, number][];

/**
 * An operation such as `/services/data/v60.0/tooling/executeAnonymous` differs only in its last segment, so a
 * plain truncation would show every row as `/services/data/v60.0/tooling…`. The cell truncates `head` and keeps
 * `tail` whole. A value without a `/` is all `head`.
 */
export function splitOperation(operation: string): { head: string; tail: string } {
  const slash = operation.replace(/\/+$/, '').lastIndexOf('/');
  if (slash < 0) {
    return { head: operation, tail: '' };
  }
  return { head: operation.slice(0, slash + 1), tail: operation.slice(slash + 1) };
}

/**
 * The host sends about 60 characters of context around a hit. A one-line cell clips the end, so the first hit
 * would fall off the right edge of a narrow column. Cut the context down to `lead` characters and shift the ranges.
 */
export function focusSnippet(text: string, ranges: SnippetRanges, lead = 16): { text: string; ranges: SnippetRanges } {
  const first = Math.min(...ranges.map(([start]) => start));
  const cut = first - lead;
  if (ranges.length === 0 || cut <= 0) {
    return { text, ranges };
  }
  return { text: `…${text.slice(cut)}`, ranges: ranges.map(([start, end]) => [start - cut + 1, end - cut + 1]) };
}
