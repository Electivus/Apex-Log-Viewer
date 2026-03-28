export function encodeJsonl(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

export class JsonlDecodeError extends Error {
  readonly frame: string;

  constructor(frame: string, cause: unknown) {
    const snippet = frame.length > 120 ? `${frame.slice(0, 117)}...` : frame;
    const suffix = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
    super(`invalid JSONL frame${suffix}`);
    this.name = 'JsonlDecodeError';
    this.frame = snippet;
  }
}

export function splitJsonl(buffer: string): { messages: unknown[]; rest: string; errors: JsonlDecodeError[] } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const messages: unknown[] = [];
  const errors: JsonlDecodeError[] = [];
  for (const line of lines.filter(Boolean)) {
    try {
      messages.push(JSON.parse(line));
    } catch (error) {
      errors.push(new JsonlDecodeError(line, error));
    }
  }
  return { messages, rest, errors };
}
