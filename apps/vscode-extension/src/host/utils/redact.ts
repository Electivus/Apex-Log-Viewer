/**
 * The one place that takes secrets out of text the extension shows, throws or logs: what a failing `sf`
 * printed, and every log line. Free of `vscode`, so the host and its node tests share it.
 */

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
  'password'
].join('|');

/** Text shaped like a Salesforce credential, whoever printed it. */
const TOKEN_SHAPES: readonly RegExp[] = [
  // An access token: the 15- or 18-character org id, "!", then the session.
  /\b00D[A-Za-z0-9]{12,15}![^\s"'`,;()[\]{}<>]{8,}/g,
  // A refresh token.
  /\b5Aep8[A-Za-z0-9._]{20,}/g,
  // A JSON Web Token.
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g
];

/** The secret each owner holds in memory, such as the access token of one org's session. */
const held = new Map<string, string>();

/** Records `value` as the secret `owner` holds now, in place of the one it held before. `undefined` forgets it. */
export function holdSecret(owner: string, value: string | undefined): void {
  if (value && value.length >= MIN_HELD_LENGTH) {
    held.set(owner, value);
  } else {
    held.delete(owner);
  }
}

/** `text` with every held secret, every token-shaped string and every secret-named value replaced. */
export function redactSecrets(text: string): string {
  let redacted = text;
  for (const value of held.values()) {
    redacted = redacted.split(value).join(REDACTED);
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
