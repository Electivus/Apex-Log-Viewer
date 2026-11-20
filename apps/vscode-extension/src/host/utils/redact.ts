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
  /\beyJ(?<!\beyJ[\w-]*?eyJ)[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g
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
 * A text read one UTF-16 unit at a time, with the stretch `[start, end)` of the text each one came from. Read as
 * written, each unit is its own stretch. Read decoded, from the first character on, each well-formed percent-encoded
 * character gives its units, which share the stretch of its encoding, and every other character is itself.
 */
type Reading = { units: Int32Array; starts: Int32Array; ends: Int32Array; length: number };

function readingOf(text: string, decoded: boolean): Reading {
  const units = new Int32Array(text.length);
  const starts = new Int32Array(text.length);
  const ends = new Int32Array(text.length);
  let length = 0;
  const add = (unit: number, start: number, end: number) => {
    units[length] = unit;
    starts[length] = start;
    ends[length++] = end;
  };
  for (let index = 0; index < text.length;) {
    const point = decoded ? encodedPointAt(text, index) : -1;
    if (point < 0) {
      add(text.charCodeAt(index), index, index + 1);
      index++;
      continue;
    }
    const end = index + encodedWidth(point);
    if (point > 0xffff) {
      add(0xd800 + ((point - 0x10000) >> 10), index, end);
      add(0xdc00 + ((point - 0x10000) & 0x3ff), index, end);
    } else {
      add(point, index, end);
    }
    index = end;
  }
  return { units, starts, ends, length };
}

/**
 * An Aho-Corasick automaton over every held secret, in UTF-16 units. Fed a reading, the node it reaches at a unit
 * names, in `longest`, how many units the longest held secret that ends there has. An edge goes on the unit's symbol,
 * its index among the units that held secrets use.
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
};

function finderOf(secrets: ReadonlySet<string>): Finder {
  const units = [...secrets].map(secret =>
    Array.from({ length: secret.length }, (_, index) => secret.charCodeAt(index))
  );
  const size = units.reduce((total, secret) => total + secret.length, 1);
  const symbols = new Map<number, number>();
  for (const unit of units.flat()) if (!symbols.has(unit)) symbols.set(unit, symbols.size);
  const finder: Finder = {
    symbols,
    chain: new Int32Array(size).fill(-1),
    edges: new Map(),
    fail: new Int32Array(size),
    longest: new Int32Array(size)
  };
  const parent = new Int32Array(size);
  const via = new Int32Array(size);
  const depth = new Int32Array(size);
  let nodes = 1;
  for (const secret of units) {
    let node = 0;
    for (const unit of secret) {
      const symbol = symbols.get(unit) ?? 0;
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

let moves = 0;

/** How many edges the automata looked for since the module loaded, building them and feeding them text. */
export const automatonMoves = (): number => moves;

/**
 * The node `finder` reaches from `node` on `symbol`, which is -1 for a unit that no held secret has. Each failure link
 * it follows leads to a shallower node, and each unit fed goes one level deeper at most, so feeding a reading looks
 * for at most two edges per unit on average.
 */
function step(finder: Finder, node: number, symbol: number): number {
  if (symbol < 0) return 0;
  for (;;) {
    moves++;
    const next = childOf(finder, node, symbol);
    if (next !== 0 || node === 0) return next;
    node = valueAt(finder.fail, node);
  }
}

/** Records in `reach`, for each place of the text where a held secret that `reading` has starts, where the longest ends. */
function reachSecrets(finder: Finder, reading: Reading, reach: Int32Array): void {
  let node = 0;
  for (let index = 0; index < reading.length; index++) {
    node = step(finder, node, finder.symbols.get(valueAt(reading.units, index)) ?? -1);
    const found = valueAt(finder.longest, node);
    if (found === 0) continue;
    const start = valueAt(reading.starts, index - found + 1);
    const end = valueAt(reading.ends, index);
    if (end > valueAt(reach, start)) reach[start] = end;
  }
}

/**
 * `text` with `[redacted]` from each place where a stretch of `reach` starts to the end of every stretch that
 * overlaps it. For each character of the result, `starts` and `ends` give the stretch of `text` it came from:
 * itself, or all that its `[redacted]` replaced.
 */
function spliced(text: string, reach: Int32Array): { masked: string; starts: number[]; ends: number[] } {
  let masked = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let from = 0;
  for (let start = 0; start < text.length; start++) {
    let end = valueAt(reach, start);
    if (end === 0) continue;
    for (let inner = start + 1; inner < end; inner++) end = Math.max(end, valueAt(reach, inner));
    masked += text.slice(from, start) + REDACTED;
    for (let index = from; index < start; index++) {
      starts.push(index);
      ends.push(index + 1);
    }
    for (let index = 0; index < REDACTED.length; index++) {
      starts.push(start);
      ends.push(end);
    }
    from = end;
    start = end - 1;
  }
  for (let index = from; index < text.length; index++) {
    starts.push(index);
    ends.push(index + 1);
  }
  return { masked: masked + text.slice(from), starts, ends };
}

/** How many characters before each place of `text` the stretches of `reach` cover. */
function coveredBy(reach: Int32Array): Int32Array {
  const covered = new Int32Array(reach.length + 1);
  for (let index = 0, end = 0; index < reach.length; index++) {
    end = Math.max(end, valueAt(reach, index));
    covered[index + 1] = valueAt(covered, index) + (index < end ? 1 : 0);
  }
  return covered;
}

/**
 * Where held secrets occur in `text`, as `reach`: as written, or in the text with its well-formed percent-encodings
 * decoded from the first character on. Each reading is fed once through the automaton. Undefined when none occurs.
 */
function heldReach(text: string): Int32Array | undefined {
  if (held.size === 0) return undefined;
  finder ??= finderOf(held);
  const reach = new Int32Array(text.length);
  reachSecrets(finder, readingOf(text, false), reach);
  if (text.includes('%')) reachSecrets(finder, readingOf(text, true), reach);
  return reach.some(end => end > 0) ? reach : undefined;
}

/** For each place of `text`, where the furthest token shape of the text as written that starts there or before it ends. */
function furthestShapeEnds(text: string): Int32Array {
  const furthest = new Int32Array(text.length);
  for (const shape of TOKEN_SHAPES) {
    for (const { index, 0: match } of text.matchAll(shape)) {
      furthest[index] = Math.max(valueAt(furthest, index), index + match.length);
    }
  }
  for (let index = 1; index < furthest.length; index++) {
    furthest[index] = Math.max(valueAt(furthest, index), valueAt(furthest, index - 1));
  }
  return furthest;
}

type Stretch = { start: number; end: number };

/**
 * Adds to `reach` what the rules match in `text` with the stretches of `reach` replaced, each rule on the text as the
 * rules before it left it. Returns the values that only their name marks, with nothing to close them.
 */
function reachRules(text: string, reach: Int32Array): Stretch[] {
  let masked = reach.some(end => end > 0) ? spliced(text, reach) : undefined;
  let isStale = false;
  const unclosed: Stretch[] = [];
  for (const rule of [...NAMED_SECRETS, ...TOKEN_SHAPES]) {
    if (isStale) masked = spliced(text, reach);
    isStale = false;
    for (const match of (masked?.masked ?? text).matchAll(rule)) {
      const [whole, name, secret, close] = match;
      const from = match.index + (secret === undefined ? 0 : (name ?? '').length);
      const to = secret === undefined ? match.index + whole.length : from + secret.length;
      const start = masked ? (masked.starts[from] ?? 0) : from;
      const end = masked ? (masked.ends[to - 1] ?? 0) : to;
      if (secret !== undefined && close === undefined) unclosed.push({ start, end });
      if (end <= valueAt(reach, start)) continue;
      reach[start] = end;
      isStale = true;
    }
  }
  return unclosed;
}

/**
 * `text` with every held secret, every token-shaped string and every secret-named value replaced, after its
 * control sequences are removed. Where held secrets occur, the union of their places is replaced at once, so a secret
 * that begins or overlaps another leaves no part of either. The rules run on the text as written, so a held secret
 * that covers part of a secret's name leaves the secret replaced, and again with the held secrets replaced, where
 * they can end a name. A value that only its name marks, with nothing to close it, is replaced to the end of every
 * token shape that runs past it, and a token shape that a held secret falls in is replaced whole.
 */
export function redactSecrets(text: string): string {
  const stripped = stripControlSequences(text);
  const reach = new Int32Array(stripped.length);
  const unclosed = reachRules(stripped, reach);
  const heldAt = heldReach(stripped);
  if (heldAt) {
    const heldCovered = coveredBy(heldAt);
    unclosed.push(...reachRules(stripped, heldAt));
    for (let index = 0; index < reach.length; index++)
      reach[index] = Math.max(valueAt(reach, index), valueAt(heldAt, index));
    // What the rules replaced beside the held secrets is blanked, so that a shape a held secret falls in starts
    // where the replaced text ends, as it does once that text reads [redacted].
    const covered = coveredBy(reach);
    let scanned = '';
    for (let index = 0; index < stripped.length; index++) {
      const replaced = valueAt(covered, index + 1) > valueAt(covered, index);
      const isHeld = valueAt(heldCovered, index + 1) > valueAt(heldCovered, index);
      scanned += replaced && !isHeld ? ' ' : stripped[index];
    }
    for (const shape of TOKEN_SHAPES) {
      for (const { index, 0: match } of scanned.matchAll(shape)) {
        const end = index + match.length;
        if (valueAt(heldCovered, end) > valueAt(heldCovered, index) && end > valueAt(reach, index)) reach[index] = end;
      }
    }
  }
  if (unclosed.length > 0) {
    const furthest = furthestShapeEnds(stripped);
    for (const { start, end } of unclosed) reach[start] = Math.max(valueAt(reach, start), valueAt(furthest, end - 1));
  }
  return reach.some(end => end > 0) ? spliced(stripped, reach).masked : stripped;
}
