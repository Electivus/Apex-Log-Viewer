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

/** How many secrets stay held; past it the oldest goes. Renewals are rare, so this spans many hours of them. */
const MAX_HELD = 256;

/** Every secret the extension received in this session, oldest first, with the pattern of its encoded forms. */
const held = new Map<string, RegExp>();

/** One hex digit of a percent-encoding, in either case. */
const hexDigit = (digit: string): string =>
  /[a-f]/i.test(digit) ? `[${digit.toUpperCase()}${digit.toLowerCase()}]` : digit;

/** `secret` with any of its characters percent-encoded, in either hex case: every way a URL can carry it. */
function percentEncodedForms(secret: string): RegExp {
  const characters = [...secret].map(character => {
    const bytes = [...Buffer.from(character, 'utf8')].map(
      byte => `%${[...byte.toString(16).padStart(2, '0')].map(hexDigit).join('')}`
    );
    return `(?:${character.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}|${bytes.join('')})`;
  });
  return new RegExp(characters.join(''), 'g');
}

/** Holds `value`, a secret the extension received, so that no later text shows it. Text with a space is no secret. */
export function holdSecret(value: unknown): void {
  if (typeof value !== 'string') return;
  const secret = stripControlSequences(value).trim();
  if (secret.length < MIN_HELD_LENGTH || /\s/.test(secret)) return;
  const encoded = held.get(secret) ?? percentEncodedForms(secret);
  held.delete(secret);
  held.set(secret, encoded);
  if (held.size > MAX_HELD) held.delete(held.keys().next().value as string);
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

/**
 * `text` with every held secret, every token-shaped string and every secret-named value replaced, after its
 * control sequences are removed.
 */
export function redactSecrets(text: string): string {
  let redacted = stripControlSequences(text);
  for (const [secret, encoded] of held) {
    redacted = redacted.split(secret).join(REDACTED);
    if (redacted.includes('%')) redacted = redacted.replace(encoded, REDACTED);
  }
  redacted = redacted.replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s,;]+/gi, `$1${REDACTED}`);
  redacted = redacted.replace(/\bBearer\s+[A-Za-z0-9._~+/=!-]{12,}/gi, `Bearer ${REDACTED}`);
  redacted = redacted.replace(
    new RegExp(`(["']?(?:${SECRET_KEY_NAMES})["']?\\s*:\\s*["'])([^"']+)(["'])`, 'gi'),
    `$1${REDACTED}$3`
  );
  redacted = redacted.replace(new RegExp(`(\\b(?:${SECRET_KEY_NAMES})\\b\\s*=\\s*)([^\\s,;]+)`, 'gi'), `$1${REDACTED}`);
  for (const shape of TOKEN_SHAPES) {
    redacted = redacted.replace(shape, REDACTED);
  }
  return redacted;
}
