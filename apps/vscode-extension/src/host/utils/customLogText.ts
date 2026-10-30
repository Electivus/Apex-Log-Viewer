export type CustomLogTextFormat = 'json' | 'text';

/** `json` when the text is one JSON object or array, otherwise `text`. */
export function detectCustomLogTextFormat(text: string): CustomLogTextFormat {
  const trimmed = text.trim();
  const framed =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (!framed) {
    return 'text';
  }
  try {
    JSON.parse(trimmed);
    return 'json';
  } catch {
    return 'text';
  }
}

function isJsonWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

/**
 * Lays valid JSON text out over several lines for reading. Only whitespace outside strings
 * changes, so every number, string and literal keeps its exact spelling (a round trip through
 * `JSON.stringify` would not keep `1e3`, `1.0` or an integer past 2^53).
 */
export function reindentJson(text: string, indent = '  '): string {
  let out = '';
  let depth = 0;
  const newline = () => `\n${indent.repeat(depth)}`;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (isJsonWhitespace(char)) {
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        end += text[end] === '\\' ? 2 : 1;
      }
      out += text.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === '{' || char === '[') {
      let next = index + 1;
      while (isJsonWhitespace(text[next])) {
        next += 1;
      }
      if (text[next] === (char === '{' ? '}' : ']')) {
        out += char + text[next];
        index = next;
        continue;
      }
      depth += 1;
      out += char + newline();
      continue;
    }
    if (char === '}' || char === ']') {
      depth = Math.max(0, depth - 1);
      out += newline() + char;
      continue;
    }
    if (char === ',') {
      out += char + newline();
      continue;
    }
    out += char === ':' ? ': ' : char;
  }
  return out;
}
