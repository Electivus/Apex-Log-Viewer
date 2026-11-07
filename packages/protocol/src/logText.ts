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
