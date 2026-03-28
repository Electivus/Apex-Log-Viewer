export function encodeJsonl(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

export function splitJsonl(buffer: string): { messages: unknown[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const messages = lines.filter(Boolean).map(line => JSON.parse(line));
  return { messages, rest };
}
