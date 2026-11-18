/**
 * The one place that takes secrets out of text the extension shows, throws or logs: what a failing `sf`
 * printed, and every log line. Free of `vscode`, so the host and its node tests share it.
 */

import { stripVTControlCharacters } from 'node:util';

/** A terminal control sequence as `sf --json` writes it inside a JSON string, such as `\u001b[31m`. */
const JSON_ESCAPED_CONTROL_SEQUENCE = /\\u001b\[[0-?]*[ -/]*[@-~]/gi;

/**
 * `text` without terminal control sequences, both as a terminal receives them and JSON-escaped, so that no
 * color code splits a secret or hides where it starts. Colors mean nothing in an error or the Output channel.
 */
export function stripControlSequences(text: string): string {
  return stripVTControlCharacters(text.replace(JSON_ESCAPED_CONTROL_SEQUENCE, ''));
}

const REDACTED = '[redacted]';

/** Shorter values are too likely to be ordinary words to replace everywhere. */
const MIN_HELD_LENGTH = 12;

const SECRET_KEY_NAMES = [
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'idToken',
  'id_token',
  'sessionId',
  'session_id',
  'sid',
  'clientSecret',
  'client_secret',
  'authorization',
  'authToken',
  'auth_token',
  'password',
  'sfdxAuthUrl'
].join('|');

const SECRET_KEYS = new Set(SECRET_KEY_NAMES.toLowerCase().split('|'));

/** Text shaped like a Salesforce credential, whoever printed it. */
const TOKEN_SHAPES: readonly RegExp[] = [
  // An access token: the 15- or 18-character org id, "!", then the session.
  /\b00D[A-Za-z0-9]{12,15}![^\s"'`,;()[\]{}<>]{8,}/g,
  // A refresh token.
  /\b5Aep8[A-Za-z0-9._]{20,}/g,
  // A JSON Web Token.
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g
];

/** Every secret the extension received in this session. */
const held = new Set<string>();

/**
 * Holds `value`, a secret the extension received, so that `redactSecrets` replaces it for the rest of the session.
 * Text with a space is no secret.
 */
export function holdSecret(value: unknown): void {
  if (typeof value !== 'string') return;
  const secret = stripControlSequences(value).trim();
  if (secret.length >= MIN_HELD_LENGTH && !/\s/.test(secret)) held.add(secret);
}

/** Holds every string under a secret-named key anywhere in `value`, such as a parsed `sf --json` answer. */
export function holdSecretsIn(value: unknown, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 10) return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') {
      if (SECRET_KEYS.has(key.toLowerCase())) holdSecret(entry);
    } else {
      holdSecretsIn(entry, depth + 1);
    }
  }
}

/** Holds the secrets of every JSON value in `text`: the whole text, its outermost braces, and each JSON line. */
export function holdSecretsInOutput(text: string): void {
  const stripped = stripControlSequences(text).trim();
  const candidates = new Set([stripped, stripped.slice(stripped.indexOf('{'), stripped.lastIndexOf('}') + 1)]);
  for (const line of stripped.split(/\r?\n/)) {
    if (/^\s*[[{]/.test(line)) candidates.add(line.trim());
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      holdSecretsIn(JSON.parse(candidate));
    } catch {
      // Not JSON: what it may carry is left to the patterns.
    }
  }
}

/** `text` with each lone surrogate as U+FFFD, the character its UTF-8 encoding decodes to. */
const wellFormed = (text: string): string =>
  text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');

/** The length of the UTF-8 character that starts with `byte`, or 0 when no character starts with it. */
function utf8Length(byte: number): number {
  if (byte < 0x80) return 1;
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 0;
}

/** The byte that a `%XX` at `index` of `text` encodes, in either hex case. */
function percentByteAt(text: string, index: number): number | undefined {
  const hex = text.slice(index, index + 3);
  return /^%[0-9a-f]{2}$/i.test(hex) ? parseInt(hex.slice(1), 16) : undefined;
}

/** The character that percent-encoded UTF-8 bytes at `index` of `text` encode, and where they end. */
function percentCharacterAt(text: string, index: number): { character: string; end: number } | undefined {
  const first = percentByteAt(text, index);
  const length = first === undefined ? 0 : utf8Length(first);
  if (length === 0) return undefined;
  const bytes: number[] = [];
  for (let offset = 0; offset < length; offset++) {
    const byte = percentByteAt(text, index + offset * 3);
    if (byte === undefined || (offset > 0 && byte >> 6 !== 0b10)) return undefined;
    bytes.push(byte);
  }
  return { character: Buffer.from(bytes).toString('utf8'), end: index + length * 3 };
}

/** A text with every percent-encoded character decoded, and for each unit where it starts and ends in the text. */
type Decoded = { text: string; starts: number[]; ends: number[] };

function percentDecoded(text: string): Decoded {
  let decoded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = 0; index < text.length;) {
    const { character, end } = percentCharacterAt(text, index) ?? { character: text.charAt(index), end: index + 1 };
    for (const unit of character.split('')) {
      decoded += unit;
      starts.push(index);
      ends.push(end);
    }
    index = end;
  }
  return { text: decoded, starts, ends };
}

/** Where each occurrence of `secret` in `text` starts, overlapping ones included. */
function startsOf(text: string, secret: string): number[] {
  const starts: number[] = [];
  for (let start = text.indexOf(secret); start !== -1; start = text.indexOf(secret, start + 1)) starts.push(start);
  return starts;
}

/**
 * Where `secret`, which has no `%` and no lone surrogate, occurs in `text` with some of its characters
 * percent-encoded. Decoding reads a `%` with the next two hex digits as one character, so when a `%` just before the
 * secret takes its first one or two characters, those are matched as written in `text` and the rest in `decoded`.
 */
function encodedSpansOf(text: string, decoded: Decoded, secret: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let taken = 0; taken <= 2 && taken < secret.length; taken++) {
    const written = secret.slice(0, taken);
    if (!/^[0-9a-f]*$/i.test(written)) break;
    const rest = secret.slice(taken);
    for (const start of startsOf(decoded.text, rest)) {
      const from = decoded.starts[start] ?? 0;
      if (text.slice(from - taken, from) !== written) continue;
      spans.push([from - taken, decoded.ends[start + rest.length - 1] ?? text.length]);
    }
  }
  return spans;
}

/**
 * Where `secret` ends at its farthest if it starts at `index` of `text` with any of its characters percent-encoded.
 * A `%` in `text` can be the secret's own `%` or start an encoding, so every reading is followed.
 */
function farthestEndAt(text: string, index: number, secret: string): number | undefined {
  let reached = new Set([index]);
  for (const character of secret) {
    const next = new Set<number>();
    for (const at of reached) {
      if (text.startsWith(character, at)) next.add(at + character.length);
      const encoded = percentCharacterAt(text, at);
      if (encoded?.character === wellFormed(character)) next.add(encoded.end);
    }
    if (next.size === 0) return undefined;
    reached = next;
  }
  return Math.max(...reached);
}

/** Where `secret` occurs in `text`, verbatim or, when `text` has a `%`, with any of its characters percent-encoded. */
function spansOf(text: string, decoded: Decoded | undefined, secret: string): Array<[number, number]> {
  const spans = startsOf(text, secret).map((start): [number, number] => [start, start + secret.length]);
  if (!decoded) return spans;
  const decodesAlike = !secret.includes('%') && secret === wellFormed(secret);
  if (decodesAlike) return [...spans, ...encodedSpansOf(text, decoded, secret)];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== secret[0] && text[start] !== '%') continue;
    const end = farthestEndAt(text, start, secret);
    if (end !== undefined) spans.push([start, end]);
  }
  return spans;
}

/**
 * `text` with every place a held secret occurs replaced, verbatim or with any of its characters percent-encoded. The
 * spans of every held secret are found on the same text and their union is masked at once, so a secret that begins
 * or overlaps another leaves no part of either.
 */
function maskHeld(text: string): string {
  const decoded = text.includes('%') ? percentDecoded(text) : undefined;
  const spans = [...held].flatMap(secret => spansOf(text, decoded, secret));
  spans.sort((a, b) => a[0] - b[0]);
  let masked = '';
  let end = 0;
  for (const [start, stop] of spans) {
    if (start >= end) masked += text.slice(end, start) + REDACTED;
    end = Math.max(end, stop);
  }
  return masked + text.slice(end);
}

/**
 * `text` with every held secret, every token-shaped string and every secret-named value replaced, after its
 * control sequences are removed.
 */
export function redactSecrets(text: string): string {
  let redacted = maskHeld(stripControlSequences(text));
  redacted = redacted.replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s,;]+/gi, `$1${REDACTED}`);
  redacted = redacted.replace(/\bBearer\s+[A-Za-z0-9._~+/=!-]{12,}/gi, `Bearer ${REDACTED}`);
  redacted = redacted.replace(
    new RegExp(`(["']?(?:${SECRET_KEY_NAMES})["']?\\s*:\\s*["'])([^"']+)(["'])`, 'gi'),
    `$1${REDACTED}$3`
  );
  redacted = redacted.replace(new RegExp(`(\\b(?:${SECRET_KEY_NAMES})\\b\\s*=\\s*)([^\\s,;]+)`, 'gi'), `$1${REDACTED}`);
  // An SFDX auth URL: client id, secret and refresh token sit between "force://" and "@", whatever they look like.
  redacted = redacted.replace(/\bforce:\/\/[^\s"'`<>@]+@/gi, `force://${REDACTED}@`);
  for (const shape of TOKEN_SHAPES) {
    redacted = redacted.replace(shape, REDACTED);
  }
  return redacted;
}
