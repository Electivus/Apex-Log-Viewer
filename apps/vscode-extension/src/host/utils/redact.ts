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

/**
 * Where `secret`, from its character at `from` on, ends if it starts at `index` of `text` with any of its characters
 * percent-encoded. Only a `%` in `secret` can be either itself or the start of an encoding, so only there are both
 * tried.
 */
function encodedEndAt(text: string, index: number, secret: string, from = 0): number | undefined {
  let at = index;
  for (let position = from; position < secret.length;) {
    const character = String.fromCodePoint(secret.codePointAt(position) ?? 0);
    if (character === '%' && text[at] === '%') {
      const end = encodedEndAt(text, at + 1, secret, position + 1);
      if (end !== undefined) return end;
    } else if (text.startsWith(character, at)) {
      at += character.length;
      position += character.length;
      continue;
    }
    const encoded = percentCharacterAt(text, at);
    if (encoded?.character !== character) return undefined;
    at = encoded.end;
    position += character.length;
  }
  return at;
}

/** Where `secret` occurs in `text`, verbatim or, when `text` has a `%`, with any of its characters percent-encoded. */
function spansOf(text: string, secret: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  if (!text.includes('%')) {
    for (let start = text.indexOf(secret); start !== -1; start = text.indexOf(secret, start + 1)) {
      spans.push([start, start + secret.length]);
    }
    return spans;
  }
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== secret[0] && text[start] !== '%') continue;
    const end = encodedEndAt(text, start, secret);
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
  const spans = [...held].flatMap(secret => spansOf(text, secret));
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
