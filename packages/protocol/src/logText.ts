export type LogTextRange = [start: number, end: number];

/** Salesforce writes `|` in log text in this form. It changes no other character, not even `&`. */
export const ESCAPED_PIPE = '&#124;';

const SOURCE_ECHO_PREFIX = 'Execute Anonymous: ';

export function decodeLogText(text: string): string {
  return text.replaceAll(ESCAPED_PIPE, '|');
}

/** The log does not escape the Apex source that Execute Anonymous echoes. */
export function decodeLogLine(line: string): string {
  return line.startsWith(SOURCE_ECHO_PREFIX) ? line : decodeLogText(line);
}

export function decodeLogLineRanges(
  line: string,
  ranges: readonly LogTextRange[]
): { text: string; ranges: LogTextRange[] } {
  const text = decodeLogLine(line);
  if (text === line) {
    return { text, ranges: [...ranges] };
  }
  return {
    text,
    ranges: ranges.map(([start, end]) => [decodedOffset(line, start, 'start'), decodedOffset(line, end, 'end')])
  };
}

function decodedOffset(line: string, rawOffset: number, edge: 'start' | 'end'): number {
  const escape = line.lastIndexOf(ESCAPED_PIPE, rawOffset - 1);
  const insideEscape = escape !== -1 && escape < rawOffset && rawOffset < escape + ESCAPED_PIPE.length;
  if (!insideEscape) {
    return decodeLogText(line.slice(0, rawOffset)).length;
  }
  const pipeOffset = decodeLogText(line.slice(0, escape)).length;
  return edge === 'start' ? pipeOffset : pipeOffset + 1;
}
