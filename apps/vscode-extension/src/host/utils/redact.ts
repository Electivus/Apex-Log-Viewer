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

/**
 * Text that names its secret before it: the secret is the second group, after the name in the first, and its
 * replacement keeps the name and the closing third group, when there is one.
 */
const NAMED_SECRETS: readonly RegExp[] = [
  /(Authorization\s*[:=]\s*Bearer\s+)([^\s,;]+)/gi,
  /(\bBearer\s+)([A-Za-z0-9._~+/=!-]{12,})/gi,
  new RegExp(`(["']?(?:${SECRET_KEY_NAMES})["']?\\s*:\\s*["'])([^"']+)(["'])`, 'gi'),
  new RegExp(`(\\b(?:${SECRET_KEY_NAMES})\\b\\s*=\\s*)([^\\s,;]+)`, 'gi'),
  // An SFDX auth URL: client id, secret and refresh token sit between "force://" and "@", whatever they look like.
  /(\bforce:\/\/)([^\s"'`<>@]+)(@)/gi
];

/** Every secret the extension received in this session. The process keeps it until it exits. */
const held = new Set<string>();

/** The finder for `held`, built again on the first redaction after a new secret is held. */
let finder: Finder | undefined;

/**
 * Holds `value`, a secret the extension received, so that `redactSecrets` replaces it for the rest of the session.
 * Text with a space is no secret.
 */
export function holdSecret(value: unknown): void {
  if (typeof value !== 'string') return;
  const secret = stripControlSequences(value).trim();
  if (secret.length < MIN_HELD_LENGTH || /\s/.test(secret) || held.has(secret)) return;
  held.add(secret);
  finder = undefined;
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
 * The well-formed UTF-8 sequences of Unicode's table 3-7, by lead byte: how many continuation bytes follow it and the
 * range of the first one. Every later continuation byte is 80..BF. No row starts at a continuation byte, C0, C1 or
 * past F4, so an overlong form, an encoded surrogate or a value past U+10FFFF decodes to nothing.
 */
const UTF8_SEQUENCES: ReadonlyArray<{ leads: [number, number]; following: number; second: [number, number] }> = [
  { leads: [0xc2, 0xdf], following: 1, second: [0x80, 0xbf] },
  { leads: [0xe0, 0xe0], following: 2, second: [0xa0, 0xbf] },
  { leads: [0xe1, 0xec], following: 2, second: [0x80, 0xbf] },
  { leads: [0xed, 0xed], following: 2, second: [0x80, 0x9f] },
  { leads: [0xee, 0xef], following: 2, second: [0x80, 0xbf] },
  { leads: [0xf0, 0xf0], following: 3, second: [0x90, 0xbf] },
  { leads: [0xf1, 0xf3], following: 3, second: [0x80, 0xbf] },
  { leads: [0xf4, 0xf4], following: 3, second: [0x80, 0x8f] }
];

const hexValue = (code: number): number => {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  const lower = code | 0x20;
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : -1;
};

/** The byte that a `%XX` at `index` of `text` encodes, in either hex case, or -1. */
function percentByteAt(text: string, index: number): number {
  if (text.charCodeAt(index) !== 0x25) return -1;
  const high = hexValue(text.charCodeAt(index + 1));
  const low = hexValue(text.charCodeAt(index + 2));
  return high < 0 || low < 0 ? -1 : high * 16 + low;
}

/** The code point that well-formed percent-encoded UTF-8 at `index` of `text` encodes, or -1. */
function encodedPointAt(text: string, index: number): number {
  const lead = percentByteAt(text, index);
  if (lead < 0x80) return lead;
  const sequence = UTF8_SEQUENCES.find(({ leads }) => lead >= leads[0] && lead <= leads[1]);
  if (!sequence) return -1;
  let point = lead & (0x3f >> sequence.following);
  for (let offset = 1; offset <= sequence.following; offset++) {
    const byte = percentByteAt(text, index + offset * 3);
    const [low, high] = offset === 1 ? sequence.second : [0x80, 0xbf];
    if (byte < low || byte > high) return -1;
    point = (point << 6) | (byte & 0x3f);
  }
  return point;
}

/** How long the percent-encoding of `point` is, in characters: three for each of its UTF-8 bytes. */
const encodedWidth = (point: number): number => 3 * (point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4);

/**
 * A text read one code point at a time, with the stretch `[start, end)` of the text each one came from. Read as
 * written, each code point is its own stretch. Read decoded, from the first character on, each well-formed
 * percent-encoded character is one code point, and every other `%` is itself.
 */
type Reading = { points: Int32Array; starts: Int32Array; ends: Int32Array; length: number };

function readingOf(text: string, decoded: boolean): Reading {
  const points = new Int32Array(text.length);
  const starts = new Int32Array(text.length);
  const ends = new Int32Array(text.length);
  let length = 0;
  for (let index = 0; index < text.length; length++) {
    let point = decoded ? encodedPointAt(text, index) : -1;
    let end: number;
    if (point >= 0) {
      end = index + encodedWidth(point);
    } else {
      point = text.codePointAt(index) ?? 0;
      end = index + (point > 0xffff ? 2 : 1);
    }
    points[length] = point;
    starts[length] = index;
    ends[length] = end;
    index = end;
  }
  return { points, starts, ends, length };
}

/**
 * An Aho-Corasick automaton over every held secret written backwards. Fed a reading from its end, the node it reaches
 * at a code point names, in `longest`, how many code points the longest held secret that starts there has. An edge
 * goes on the code point's symbol, its index among the code points that held secrets use.
 */
type Finder = {
  symbols: Map<number, number>;
  /**
   * For each node, the symbol of its edge to the node numbered right after it, or -1. The nodes that only one secret
   * reaches are numbered in a row, so most edges need no entry in `edges`.
   */
  chain: Int32Array;
  /** Every other edge, keyed by node and symbol. */
  edges: Map<number, number>;
  fail: Int32Array;
  longest: Int32Array;
  /** Remembered moves on the characters of an encoding's tail from nodes without that edge. */
  jumps: Map<number, number>;
};

function finderOf(secrets: ReadonlySet<string>): Finder {
  const backwards = [...secrets].map(secret =>
    Array.from(secret, character => character.codePointAt(0) ?? 0).reverse()
  );
  const size = backwards.reduce((total, points) => total + points.length, 1);
  const symbols = new Map<number, number>();
  for (const point of backwards.flat()) if (!symbols.has(point)) symbols.set(point, symbols.size);
  const finder: Finder = {
    symbols,
    chain: new Int32Array(size).fill(-1),
    edges: new Map(),
    fail: new Int32Array(size),
    longest: new Int32Array(size),
    jumps: new Map()
  };
  const parent = new Int32Array(size);
  const via = new Int32Array(size);
  const depth = new Int32Array(size);
  let nodes = 1;
  for (const points of backwards) {
    let node = 0;
    for (const point of points) {
      const symbol = symbols.get(point) ?? 0;
      let next = childOf(finder, node, symbol);
      if (next === 0) {
        next = nodes++;
        if (next === node + 1) finder.chain[node] = symbol;
        else finder.edges.set(edgeKey(finder, node, symbol), next);
        parent[next] = node;
        via[next] = symbol;
        depth[next] = valueAt(depth, node) + 1;
      }
      node = next;
    }
    finder.longest[node] = valueAt(depth, node);
  }
  const byDepth: number[][] = [];
  for (let node = 1; node < nodes; node++) (byDepth[valueAt(depth, node)] ??= []).push(node);
  for (const level of byDepth) {
    for (const node of level ?? []) {
      const from = valueAt(parent, node);
      if (from !== 0) finder.fail[node] = step(finder, valueAt(finder.fail, from), valueAt(via, node));
      if (finder.longest[node] === 0) finder.longest[node] = valueAt(finder.longest, valueAt(finder.fail, node));
    }
  }
  finder.chain = finder.chain.slice(0, nodes);
  finder.fail = finder.fail.slice(0, nodes);
  finder.longest = finder.longest.slice(0, nodes);
  return finder;
}

/** `values[index]`, for an index that its caller keeps in bounds. */
const valueAt = (values: Int32Array, index: number): number => values[index] ?? 0;

const edgeKey = (finder: Finder, node: number, symbol: number): number => node * finder.symbols.size + symbol;

/** The node an edge on `symbol` leads to from `node`, or 0, the root, which no edge leads to. */
const childOf = (finder: Finder, node: number, symbol: number): number =>
  valueAt(finder.chain, node) === symbol ? node + 1 : (finder.edges.get(edgeKey(finder, node, symbol)) ?? 0);

/** The node `finder` reaches from `node` on `symbol`, which is -1 for a code point that no held secret has. */
function step(finder: Finder, node: number, symbol: number): number {
  if (symbol < 0) return 0;
  for (;;) {
    const next = childOf(finder, node, symbol);
    if (next !== 0 || node === 0) return next;
    node = valueAt(finder.fail, node);
  }
}

/**
 * `step` on a character of an encoding's tail, remembered for every node it passes. A tail is read from a node it
 * does not move the main feed to, so without the memory each one could walk the whole failure chain again.
 */
function jump(finder: Finder, node: number, symbol: number): number {
  if (symbol < 0) return 0;
  const passed: number[] = [];
  let next: number | undefined;
  for (;;) {
    const key = edgeKey(finder, node, symbol);
    const child = childOf(finder, node, symbol);
    next = child !== 0 ? child : finder.jumps.get(key);
    if (next !== undefined || node === 0) break;
    passed.push(key);
    node = valueAt(finder.fail, node);
  }
  for (const key of passed) finder.jumps.set(key, next ?? 0);
  return next ?? 0;
}

/**
 * Records in `reach`, for each place of `text` where a held secret starts in `reading`, where the longest one ends. A
 * reader that starts inside a percent-encoding takes the rest of it as written and decodes from the next character,
 * so the tail of each encoding is also read as the start of a secret.
 */
function reachSecrets(finder: Finder, text: string, reading: Reading, reach: Int32Array): void {
  const startOf = (index: number) => valueAt(reading.starts, index);
  const endOf = (index: number) => valueAt(reading.ends, index);
  const extend = (start: number, end: number) => {
    if (end > valueAt(reach, start)) reach[start] = end;
  };
  let node = 0;
  for (let index = reading.length - 1; index >= 0; index--) {
    node = step(finder, node, finder.symbols.get(valueAt(reading.points, index)) ?? -1);
    const found = valueAt(finder.longest, node);
    if (found > 0) extend(startOf(index), endOf(index + found - 1));
    const before = index - 1;
    if (before < 0 || endOf(before) - startOf(before) < 3) continue;
    let tail = node;
    for (let at = endOf(before) - 1; at > startOf(before); at--) {
      tail = jump(finder, tail, finder.symbols.get(text.charCodeAt(at)) ?? -1);
      const length = valueAt(finder.longest, tail);
      const written = endOf(before) - at;
      if (length > 0) extend(at, length <= written ? at + length : endOf(index + length - written - 1));
    }
  }
}

/**
 * `text` with every place a held secret occurs replaced: as written, or as a reader that decodes the well-formed
 * percent-encodings from any place of the text reads it. The places of every held secret are found in one pass over
 * each reading, and their union is replaced at once, so a secret that begins or overlaps another leaves no part of
 * either. A token shape that a held secret falls in is replaced with it, since the shape no longer matches once the
 * secret inside it is replaced. So is every named secret of the text, since the stretch of such a shape can take in
 * the name that comes after it.
 */
function maskHeld(text: string): string {
  if (held.size === 0) return text;
  finder ??= finderOf(held);
  const reach = new Int32Array(text.length);
  reachSecrets(finder, text, readingOf(text, false), reach);
  if (text.includes('%')) reachSecrets(finder, text, readingOf(text, true), reach);
  /** How many characters before each place of `text` a held secret covers. */
  const covered = new Int32Array(text.length + 1);
  for (let index = 0, end = 0; index < text.length; index++) {
    end = Math.max(end, valueAt(reach, index));
    covered[index + 1] = valueAt(covered, index) + (index < end ? 1 : 0);
  }
  if (valueAt(covered, text.length) > 0) {
    const extend = (start: number, end: number) => {
      if (end > valueAt(reach, start)) reach[start] = end;
    };
    for (const shape of TOKEN_SHAPES) {
      for (const { index, 0: match } of text.matchAll(shape)) {
        const end = index + match.length;
        if (valueAt(covered, end) > valueAt(covered, index)) extend(index, end);
      }
    }
    for (const named of NAMED_SECRETS) {
      for (const { index, 1: name = '', 2: secret = '' } of text.matchAll(named)) {
        extend(index + name.length, index + name.length + secret.length);
      }
    }
  }
  let masked = '';
  let end = 0;
  for (let start = 0; start < text.length; start++) {
    const stop = valueAt(reach, start);
    if (stop === 0) continue;
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
  for (const named of NAMED_SECRETS) {
    redacted = redacted.replace(named, (_match, name: string, _secret: string, close: unknown) =>
      typeof close === 'string' ? `${name}${REDACTED}${close}` : `${name}${REDACTED}`
    );
  }
  for (const shape of TOKEN_SHAPES) {
    redacted = redacted.replace(shape, REDACTED);
  }
  return redacted;
}
