import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolveRepoRoot(process.argv.slice(2));
const disallowedSchemes = new Set([
  'git:',
  'ssh:',
  'github:',
  'gitlab:',
  'bitbucket:',
  'gist:',
  'http:',
  'https:',
  'file:',
  'link:'
]);

function resolveRepoRoot(args) {
  const rootFlagIndex = args.indexOf('--root');
  if (rootFlagIndex === -1) {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  }

  const rootValue = args[rootFlagIndex + 1];
  if (!rootValue) {
    throw new Error('Missing path after --root');
  }
  return path.resolve(rootValue);
}

function rootManifest() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
}

function workspacePatterns() {
  const workspaces = rootManifest().workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter(pattern => typeof pattern === 'string' && pattern.trim());
  }
  if (Array.isArray(workspaces?.packages)) {
    return workspaces.packages.filter(pattern => typeof pattern === 'string' && pattern.trim());
  }
  const pnpmWorkspacePath = path.join(repoRoot, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmWorkspacePath)) {
    const patterns = [];
    let inPackages = false;
    for (const line of fs.readFileSync(pnpmWorkspacePath, 'utf8').split(/\r?\n/u)) {
      if (/^packages:\s*$/u.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages && /^\S/u.test(line)) break;
      const match = inPackages ? line.match(/^\s+-\s+['"]?([^'"]+)['"]?\s*$/u) : undefined;
      if (match?.[1]) patterns.push(match[1]);
    }
    return patterns;
  }
  return [];
}

function collectWorkspacePaths(baseDir, fileName) {
  const dirPath = path.join(repoRoot, baseDir);
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(dirPath, entry.name, fileName))
    .filter(filePath => fs.existsSync(filePath));
}

function workspaceFilePaths(fileName) {
  const paths = new Set();
  const wildcardSuffix = '/*';

  for (const pattern of workspacePatterns()) {
    const normalizedPattern = pattern.replace(/\\/g, '/').replace(/\/+$/, '');

    if (normalizedPattern.endsWith(wildcardSuffix)) {
      for (const filePath of collectWorkspacePaths(normalizedPattern.slice(0, -wildcardSuffix.length), fileName)) {
        paths.add(filePath);
      }
      continue;
    }

    const filePath = path.join(repoRoot, normalizedPattern, fileName);
    if (fs.existsSync(filePath)) {
      paths.add(filePath);
    }
  }

  return Array.from(paths);
}

function manifests() {
  return [path.join(repoRoot, 'package.json'), ...workspaceFilePaths('package.json')];
}

function lockfiles() {
  return Array.from(
    new Set(
      ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml'].flatMap(fileName => [
        path.join(repoRoot, fileName),
        ...workspaceFilePaths(fileName)
      ])
    )
  ).filter(filePath => fs.existsSync(filePath));
}

function hasBlockedManifestSource(version) {
  return isRemoteDependencySpec(version);
}

function looksLikeUrl(value) {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value);
}

function normalizedDependencyScheme(value) {
  const match = value.match(/^([a-zA-Z][a-zA-Z\d+.-]*:)/);
  if (!match) {
    return '';
  }
  return match[1].toLowerCase();
}

function looksLikeHostedGitShorthand(value) {
  return /^[^./@\s][^/\s]*\/[^/\s#]+(?:#[^\s]+)?$/.test(value);
}

function looksLikeScpStyleGitSpec(value) {
  return /^[^/\s@]+@[^:/\s]+:[^/\s]+\/[^/\s#]+(?:#[^\s]+)?$/.test(value);
}

function npmAliasTargetSpec(value) {
  if (!value.toLowerCase().startsWith('npm:')) {
    return '';
  }

  const aliasTarget = value.slice('npm:'.length).trim();
  if (!aliasTarget) {
    return '';
  }

  if (aliasTarget.startsWith('@')) {
    const scopeSeparatorIndex = aliasTarget.indexOf('/');
    if (scopeSeparatorIndex === -1) {
      return '';
    }

    const targetSeparatorIndex = aliasTarget.indexOf('@', scopeSeparatorIndex + 1);
    return targetSeparatorIndex === -1 ? '' : aliasTarget.slice(targetSeparatorIndex + 1).trim();
  }

  const targetSeparatorIndex = aliasTarget.indexOf('@');
  return targetSeparatorIndex === -1 ? '' : aliasTarget.slice(targetSeparatorIndex + 1).trim();
}

function isRemoteDependencySpec(value) {
  const aliasTarget = npmAliasTargetSpec(value);
  if (aliasTarget) {
    return isRemoteDependencySpec(aliasTarget);
  }

  const scheme = normalizedDependencyScheme(value);
  if (scheme) {
    return scheme.startsWith('git+') || disallowedSchemes.has(scheme);
  }

  return looksLikeHostedGitShorthand(value) || looksLikeScpStyleGitSpec(value);
}

function isRegistryTarball(resolved) {
  if (!looksLikeUrl(resolved)) {
    return false;
  }

  try {
    const url = new URL(resolved);
    return url.protocol === 'https:' && url.hostname === 'registry.npmjs.org';
  } catch {
    return false;
  }
}

function isPathInsideRepo(candidatePath) {
  const relativePath = path.relative(repoRoot, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function formatRelativePathForReport(candidatePath) {
  return path.relative(repoRoot, candidatePath).replace(/\\/g, '/');
}

function declaredWorkspacePackages() {
  const packages = new Map();

  for (const packageJsonPath of workspaceFilePaths('package.json')) {
    const packageDir = path.dirname(packageJsonPath);
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const packageName = typeof manifest.name === 'string' ? manifest.name.trim() : '';
    if (!packageName) {
      continue;
    }

    packages.set(packageDir, packageName);
  }

  return packages;
}

const workspacePackageNamesByDir = declaredWorkspacePackages();

function isWorkspaceLink(packageName, resolved) {
  if (looksLikeUrl(resolved) || path.isAbsolute(resolved)) {
    return false;
  }

  const resolvedPath = path.resolve(repoRoot, resolved);
  if (!isPathInsideRepo(resolvedPath) || !fs.existsSync(resolvedPath)) {
    return false;
  }

  return workspacePackageNamesByDir.get(resolvedPath) === packageName;
}

function lockEntryName(packagePath, packageMeta) {
  const marker = 'node_modules/';
  const markerIndex = packagePath.lastIndexOf(marker);
  if (markerIndex !== -1) {
    return packagePath.slice(markerIndex + marker.length);
  }

  if (typeof packageMeta.name === 'string' && packageMeta.name.trim()) {
    return packageMeta.name.trim();
  }
  if (!packagePath) {
    return '(root)';
  }

  return packagePath;
}

function collectLegacyLockEntries(dependencies, trail = []) {
  if (!dependencies || typeof dependencies !== 'object') {
    return [];
  }

  const entries = [];
  for (const [name, packageMeta] of Object.entries(dependencies)) {
    if (!packageMeta || typeof packageMeta !== 'object') {
      continue;
    }

    const dependencyPath = trail.length === 0 ? name : `${trail.join(' > ')} > ${name}`;
    entries.push({ dependencyPath, name, packageMeta });
    entries.push(...collectLegacyLockEntries(packageMeta.dependencies, [...trail, name]));
  }
  return entries;
}

function legacyLockSource(packageMeta) {
  const resolved = typeof packageMeta.resolved === 'string' ? packageMeta.resolved.trim() : '';
  if (resolved) {
    return resolved;
  }

  const version = typeof packageMeta.version === 'string' ? packageMeta.version.trim() : '';
  return isRemoteDependencySpec(version) ? version : '';
}

function lockPackageSource(packageMeta) {
  const resolved = typeof packageMeta.resolved === 'string' ? packageMeta.resolved.trim() : '';
  if (resolved) {
    return resolved;
  }

  const version = typeof packageMeta.version === 'string' ? packageMeta.version.trim() : '';
  return isRemoteDependencySpec(version) ? version : '';
}

// pnpm-lock.yaml is read as YAML, not as lines, so that free text such as a
// package's `deprecated:` message cannot fail the check and cannot hide a source.
// The reader accepts only the YAML subset that pnpm writes (block mappings and
// sequences, single-line flow collections, plain/quoted/block scalars) and fails
// closed on anything else: comments, anchors, aliases, tags, merge keys, duplicate
// keys, explicit `? ` keys, multi-line flow or quoted scalars, tabs, control
// characters, lines that start with a Unicode space other than U+0020, and line
// breaks other than LF or CRLF. Anything it cannot read the way a YAML parser
// would is reported, never skipped.

const sourcePattern = /(?:git\+|https?:\/\/|github:|gitlab:|bitbucket:|gist:|file:)[^\s'",}\]]+/giu;

class PnpmLockSyntaxError extends Error {
  constructor(lineNumber, reason) {
    super(reason);
    this.lineNumber = lineNumber;
  }
}

const doubleQuotedEscapes = new Map([
  ['0', '\0'],
  ['a', '\x07'],
  ['b', '\b'],
  ['t', '\t'],
  ['n', '\n'],
  ['v', '\v'],
  ['f', '\f'],
  ['r', '\r'],
  ['e', '\x1b'],
  [' ', ' '],
  ['"', '"'],
  ['/', '/'],
  ['\\', '\\'],
  ['N', '\x85'],
  ['_', '\xa0'],
  ['L', '\u2028'],
  ['P', '\u2029']
]);
const doubleQuotedHexEscapeLengths = new Map([
  ['x', 2],
  ['u', 4],
  ['U', 8]
]);

function scalarNode(lineNumber, value, segments = [{ lineNumber, text: value }]) {
  return { kind: 'scalar', lineNumber, value, segments };
}

// YAML separates and indents with U+0020 only (tabs are rejected up front).
// String.prototype.trim() also strips Unicode spaces such as U+00A0 and U+3000,
// which YAML reads as content, so the reader never uses it.
function trimSpaces(text) {
  return trimEndSpaces(text.replace(/^ +/u, ''));
}

function trimEndSpaces(text) {
  return text.replace(/ +$/u, '');
}

function indentOf(text) {
  return /^ */u.exec(text)[0].length;
}

function isBlank(text) {
  return /^ *$/u.test(text);
}

function isSequenceEntry(text, indent) {
  return text[indent] === '-' && (text.length === indent + 1 || text[indent + 1] === ' ');
}

function readQuotedScalar(text, start, lineNumber) {
  const quote = text[start];
  let value = '';
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") {
        if (text[index + 1] === "'") {
          value += "'";
          index += 2;
          continue;
        }
        return { value, end: index + 1 };
      }
      value += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      return { value, end: index + 1 };
    }
    if (char !== '\\') {
      value += char;
      index += 1;
      continue;
    }
    const escape = text[index + 1];
    if (escape === undefined) {
      throw new PnpmLockSyntaxError(lineNumber, 'multi-line double-quoted scalar');
    }
    if (doubleQuotedEscapes.has(escape)) {
      value += doubleQuotedEscapes.get(escape);
      index += 2;
      continue;
    }
    const hexLength = doubleQuotedHexEscapeLengths.get(escape);
    const hex = hexLength ? text.slice(index + 2, index + 2 + hexLength) : '';
    if (!hexLength || !/^[0-9a-fA-F]+$/u.test(hex) || hex.length !== hexLength) {
      throw new PnpmLockSyntaxError(lineNumber, `unsupported escape \\${escape}`);
    }
    const codePoint = Number.parseInt(hex, 16);
    if (codePoint > 0x10ffff) {
      throw new PnpmLockSyntaxError(lineNumber, `unsupported escape \\${escape}${hex}`);
    }
    value += String.fromCodePoint(codePoint);
    index += 2 + hexLength;
  }
  throw new PnpmLockSyntaxError(lineNumber, 'multi-line or unterminated quoted scalar');
}

function assertPlainScalar(value, lineNumber, inFlow) {
  if (!value) {
    throw new PnpmLockSyntaxError(lineNumber, 'empty plain scalar');
  }
  const first = value[0];
  if (',[]{}#&*!|>\'"%@`'.includes(first)) {
    throw new PnpmLockSyntaxError(lineNumber, `plain scalar starts with indicator ${first}`);
  }
  if ('-?:'.includes(first) && (value.length === 1 || value[1] === ' ' || (inFlow && ',[]{}'.includes(value[1])))) {
    throw new PnpmLockSyntaxError(lineNumber, `plain scalar starts with indicator ${first}`);
  }
  if (value.includes(' #')) {
    throw new PnpmLockSyntaxError(lineNumber, 'comment');
  }
  if (/:(?: |$)/u.test(value)) {
    throw new PnpmLockSyntaxError(lineNumber, 'unexpected mapping indicator in a plain scalar');
  }
  if (inFlow && /[[\]{}]/u.test(value)) {
    throw new PnpmLockSyntaxError(lineNumber, 'flow indicator in a plain scalar');
  }
  if (value !== trimSpaces(value)) {
    throw new PnpmLockSyntaxError(lineNumber, 'unexpected whitespace around a plain scalar');
  }
}

function skipSpaces(text, index) {
  while (text[index] === ' ') index += 1;
  return index;
}

function readFlowScalar(text, start, lineNumber) {
  if (text[start] === "'" || text[start] === '"') {
    const { value, end } = readQuotedScalar(text, start, lineNumber);
    return { node: scalarNode(lineNumber, value), end };
  }
  let end = start;
  while (end < text.length) {
    const char = text[end];
    if (char === ',' || char === '}' || char === ']') break;
    if (char === ':' && (end + 1 === text.length || ' ,[]{}'.includes(text[end + 1]))) break;
    end += 1;
  }
  const value = trimEndSpaces(text.slice(start, end));
  assertPlainScalar(value, lineNumber, true);
  return { node: scalarNode(lineNumber, value), end: start + value.length };
}

function readFlowNode(text, start, lineNumber) {
  const index = skipSpaces(text, start);
  if (text[index] === '{') return readFlowMapping(text, index, lineNumber);
  if (text[index] === '[') return readFlowSequence(text, index, lineNumber);
  return readFlowScalar(text, index, lineNumber);
}

function readFlowMapping(text, start, lineNumber) {
  const node = { kind: 'map', style: 'flow', lineNumber, entries: [] };
  const keys = new Set();
  let index = skipSpaces(text, start + 1);
  if (text[index] === '}') return { node, end: index + 1 };
  for (;;) {
    if (text[index] === '{' || text[index] === '[') {
      throw new PnpmLockSyntaxError(lineNumber, 'complex mapping key');
    }
    const key = readFlowScalar(text, index, lineNumber);
    if (key.node.value === '<<') {
      throw new PnpmLockSyntaxError(lineNumber, 'merge key');
    }
    if (keys.has(key.node.value)) {
      throw new PnpmLockSyntaxError(lineNumber, `duplicate key ${key.node.value}`);
    }
    keys.add(key.node.value);
    index = skipSpaces(text, key.end);
    if (text[index] !== ':' || text[index + 1] !== ' ') {
      throw new PnpmLockSyntaxError(lineNumber, 'flow mapping entry without a value');
    }
    const value = readFlowNode(text, index + 1, lineNumber);
    node.entries.push({ key: key.node, value: value.node });
    index = skipSpaces(text, value.end);
    if (text[index] === '}') return { node, end: index + 1 };
    if (text[index] !== ',') {
      throw new PnpmLockSyntaxError(lineNumber, 'multi-line or malformed flow mapping');
    }
    index = skipSpaces(text, index + 1);
    if (text[index] === '}' || index >= text.length) {
      throw new PnpmLockSyntaxError(lineNumber, 'multi-line or malformed flow mapping');
    }
  }
}

function readFlowSequence(text, start, lineNumber) {
  const node = { kind: 'seq', style: 'flow', lineNumber, items: [] };
  let index = skipSpaces(text, start + 1);
  if (text[index] === ']') return { node, end: index + 1 };
  for (;;) {
    const item = readFlowNode(text, index, lineNumber);
    node.items.push(item.node);
    index = skipSpaces(text, item.end);
    if (text[index] === ']') return { node, end: index + 1 };
    if (text[index] !== ',') {
      throw new PnpmLockSyntaxError(lineNumber, 'multi-line or malformed flow sequence');
    }
    index = skipSpaces(text, index + 1);
    if (text[index] === ']' || index >= text.length) {
      throw new PnpmLockSyntaxError(lineNumber, 'multi-line or malformed flow sequence');
    }
  }
}

function readInlineValue(text, lineNumber) {
  if (text[0] === '{' || text[0] === '[' || text[0] === "'" || text[0] === '"') {
    const { node, end } = readFlowNode(text, 0, lineNumber);
    if (!isBlank(text.slice(end))) {
      throw new PnpmLockSyntaxError(lineNumber, 'unexpected text after a value');
    }
    return node;
  }
  assertPlainScalar(text, lineNumber, false);
  return scalarNode(lineNumber, text);
}

class PnpmLockReader {
  constructor(lines) {
    this.lines = lines;
    this.position = 0;
  }

  peekSignificant() {
    while (this.position < this.lines.length && isBlank(this.lines[this.position].text)) {
      this.position += 1;
    }
    const line = this.lines[this.position];
    if (!line) return line;
    const content = line.text.slice(indentOf(line.text));
    // Fail closed when a structural line starts with any other Unicode space,
    // even though YAML would read it as content: no pnpm key starts with one.
    if (/^\s/u.test(content)) {
      const codePoint = content.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      throw new PnpmLockSyntaxError(line.lineNumber, `non-space whitespace U+${codePoint} in the indentation`);
    }
    if (content.startsWith('#')) {
      throw new PnpmLockSyntaxError(line.lineNumber, 'comment');
    }
    return line;
  }

  readDocument() {
    const first = this.peekSignificant();
    if (!first) return undefined;
    if (indentOf(first.text) !== 0 || isSequenceEntry(first.text, 0)) {
      throw new PnpmLockSyntaxError(first.lineNumber, 'document root is not a mapping');
    }
    const root = this.readBlockMapping(0);
    const rest = this.peekSignificant();
    if (rest) {
      throw new PnpmLockSyntaxError(rest.lineNumber, 'unexpected indentation');
    }
    return root;
  }

  readBlockCollection(indent) {
    const line = this.peekSignificant();
    return isSequenceEntry(line.text, indent) ? this.readBlockSequence(indent) : this.readBlockMapping(indent);
  }

  readBlockMapping(indent) {
    const node = { kind: 'map', style: 'block', lineNumber: this.peekSignificant().lineNumber, entries: [] };
    const keys = new Set();
    for (let line = this.peekSignificant(); line; line = this.peekSignificant()) {
      const lineIndent = indentOf(line.text);
      if (lineIndent < indent) break;
      if (lineIndent > indent || isSequenceEntry(line.text, indent)) {
        throw new PnpmLockSyntaxError(line.lineNumber, 'unexpected indentation');
      }
      this.position += 1;
      const text = trimEndSpaces(line.text);
      const { key, rest } = this.readKey(text, indent, line.lineNumber);
      if (keys.has(key.value)) {
        throw new PnpmLockSyntaxError(line.lineNumber, `duplicate key ${key.value}`);
      }
      keys.add(key.value);
      let value;
      if (rest === '') {
        value = this.readNestedBlock(indent, line.lineNumber);
      } else if (rest[0] === '|' || rest[0] === '>') {
        value = this.readBlockScalar(indent, rest, line.lineNumber);
      } else {
        value = readInlineValue(rest, line.lineNumber);
      }
      node.entries.push({ key, value });
    }
    return node;
  }

  readKey(text, indent, lineNumber) {
    const body = text.slice(indent);
    // js-yaml writes a key longer than 1024 characters as an explicit `? key`
    // followed by `: value`. pnpm caps the peer suffix of a lockfile key at 1000
    // characters, so only a long package name and a near-limit suffix reach it;
    // this repository's longest key has 258. Such a lockfile fails closed here.
    if (body.startsWith('? ') || body === '?') {
      throw new PnpmLockSyntaxError(
        lineNumber,
        'explicit "? " mapping key, which pnpm writes only for a key over 1024 characters'
      );
    }
    let key;
    let afterKey;
    if (body[0] === "'" || body[0] === '"') {
      const quoted = readQuotedScalar(body, 0, lineNumber);
      key = scalarNode(lineNumber, quoted.value);
      afterKey = body.slice(quoted.end);
    } else {
      const separator = body.search(/:(?: |$)/u);
      if (separator === -1) {
        throw new PnpmLockSyntaxError(lineNumber, 'mapping entry without a key');
      }
      const value = body.slice(0, separator);
      assertPlainScalar(value, lineNumber, false);
      if (value === '<<') {
        throw new PnpmLockSyntaxError(lineNumber, 'merge key');
      }
      key = scalarNode(lineNumber, value);
      afterKey = body.slice(separator);
    }
    if (afterKey !== ':' && !afterKey.startsWith(': ')) {
      throw new PnpmLockSyntaxError(lineNumber, 'mapping entry without a key');
    }
    return { key, rest: trimSpaces(afterKey.slice(1)) };
  }

  readNestedBlock(indent, lineNumber) {
    const next = this.peekSignificant();
    if (next) {
      const nextIndent = indentOf(next.text);
      if (nextIndent > indent) return this.readBlockCollection(nextIndent);
      if (nextIndent === indent && isSequenceEntry(next.text, indent)) return this.readBlockSequence(indent);
    }
    return scalarNode(lineNumber, '', []);
  }

  readBlockSequence(indent) {
    const node = { kind: 'seq', style: 'block', lineNumber: this.peekSignificant().lineNumber, items: [] };
    for (let line = this.peekSignificant(); line; line = this.peekSignificant()) {
      const lineIndent = indentOf(line.text);
      if (lineIndent < indent || (lineIndent === indent && !isSequenceEntry(line.text, indent))) break;
      if (lineIndent > indent) {
        throw new PnpmLockSyntaxError(line.lineNumber, 'unexpected indentation');
      }
      this.position += 1;
      const item = trimSpaces(line.text.slice(indent + 1));
      if (!item || item[0] === '|' || item[0] === '>') {
        throw new PnpmLockSyntaxError(line.lineNumber, 'unsupported sequence entry');
      }
      node.items.push(readInlineValue(item, line.lineNumber));
    }
    return node;
  }

  readBlockScalar(indent, header, lineNumber) {
    const headerMatch = /^[|>](?:([1-9])[+-]?|[+-]([1-9])?)?$/u.exec(header);
    if (!headerMatch) {
      throw new PnpmLockSyntaxError(lineNumber, 'unsupported block scalar header');
    }
    // An explicit indentation indicator (js-yaml writes one when the text starts with a space)
    // counts from the mapping's own indentation.
    const indicator = headerMatch[1] ?? headerMatch[2];
    const segments = [];
    let contentIndent = indicator ? indent + Number(indicator) : -1;
    let leadingBlankWidth = 0;
    while (this.position < this.lines.length) {
      const line = this.lines[this.position];
      if (isBlank(line.text)) {
        if (contentIndent === -1) leadingBlankWidth = Math.max(leadingBlankWidth, line.text.length);
        segments.push({ lineNumber: line.lineNumber, text: '' });
        this.position += 1;
        continue;
      }
      const lineIndent = indentOf(line.text);
      if (contentIndent === -1) {
        if (lineIndent <= indent) break;
        if (leadingBlankWidth > lineIndent) {
          throw new PnpmLockSyntaxError(line.lineNumber, 'block scalar leading blank line is over-indented');
        }
        contentIndent = lineIndent;
      }
      if (lineIndent < contentIndent) break;
      segments.push({ lineNumber: line.lineNumber, text: line.text.slice(contentIndent) });
      this.position += 1;
    }
    while (segments.length > 0 && segments[segments.length - 1].text === '') segments.pop();
    return scalarNode(lineNumber, segments.map(segment => segment.text).join('\n'), segments);
  }
}

function parsePnpmLockDocuments(content) {
  const text = content.startsWith('\uFEFF') ? content.slice(1) : content;
  const forbidden = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\t\u2028\u2029\uFEFF\uFFFE\uFFFF]|\r(?!\n)/u.exec(text);
  if (forbidden) {
    const lineNumber = text.slice(0, forbidden.index).split('\n').length;
    const codePoint = forbidden[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    throw new PnpmLockSyntaxError(lineNumber, `unsupported character U+${codePoint}`);
  }

  const documents = [];
  let current = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const lineNumber = index + 1;
    if (line === '---') {
      documents.push(current);
      current = [];
      continue;
    }
    if (line.startsWith('---') || line.startsWith('...') || line.startsWith('%')) {
      throw new PnpmLockSyntaxError(lineNumber, 'unsupported document marker or directive');
    }
    current.push({ lineNumber, text: line });
  }
  documents.push(current);

  return documents.map(lines => new PnpmLockReader(lines).readDocument()).filter(Boolean);
}

function mappingValue(node, key) {
  if (node?.kind !== 'map') return undefined;
  return node.entries.find(entry => entry.key.value === key)?.value;
}

// The only free text in a pnpm lockfile: `packages.<id>.deprecated`, written
// as a scalar in block mappings. Every other key and value is scanned.
function isDeprecationMessage(trail, node) {
  return (
    node.kind === 'scalar' &&
    trail.length === 3 &&
    trail[0].key === 'packages' &&
    trail[2].key === 'deprecated' &&
    trail.every(step => step.style === 'block')
  );
}

function scanPnpmLockNode(node, trail, report) {
  if (node.kind === 'scalar') {
    if (!isDeprecationMessage(trail, node)) {
      for (const segment of node.segments) report(segment.lineNumber, segment.text);
    }
    return;
  }
  if (node.kind === 'seq') {
    node.items.forEach((item, index) => scanPnpmLockNode(item, [...trail, { key: index, style: node.style }], report));
    return;
  }
  for (const { key, value } of node.entries) {
    scanPnpmLockNode(key, [...trail, { key: null, style: node.style }], report);
    scanPnpmLockNode(value, [...trail, { key: key.value, style: node.style }], report);
  }
}

function validatePnpmImporterLinks(lockfilePath, document, failures) {
  const importers = mappingValue(document, 'importers');
  if (importers?.kind !== 'map') return;
  for (const { key: importerKey, value: importer } of importers.entries) {
    if (importer.kind !== 'map') continue;
    const importerDir = path.resolve(repoRoot, importerKey.value === '.' ? '' : importerKey.value);
    for (const { value: section } of importer.entries) {
      if (section.kind !== 'map') continue;
      for (const { key: dependencyKey, value: dependency } of section.entries) {
        const version = mappingValue(dependency, 'version');
        if (version?.kind !== 'scalar' || !version.value.startsWith('link:')) continue;
        const target = version.value.slice('link:'.length);
        const linkedPath = path.resolve(importerDir, target);
        if (workspacePackageNamesByDir.get(linkedPath) !== dependencyKey.value) {
          failures.push(
            `${formatRelativePathForReport(lockfilePath)}:${version.lineNumber} -> ${dependencyKey.value || '(unknown)'} -> link:${target}`
          );
        }
      }
    }
  }
}

function validatePnpmLock(lockfilePath, failures) {
  let documents;
  try {
    documents = parsePnpmLockDocuments(fs.readFileSync(lockfilePath, 'utf8'));
  } catch (error) {
    if (!(error instanceof PnpmLockSyntaxError)) throw error;
    failures.push(
      `${formatRelativePathForReport(lockfilePath)}:${error.lineNumber} -> unsupported YAML (${error.message}); the check reads only the YAML that pnpm writes`
    );
    return;
  }

  for (const document of documents) {
    validatePnpmImporterLinks(lockfilePath, document, failures);
    scanPnpmLockNode(document, [], (lineNumber, text) => {
      for (const match of text.matchAll(sourcePattern)) {
        const source = match[0];
        if (!isRegistryTarball(source)) {
          failures.push(`${formatRelativePathForReport(lockfilePath)}:${lineNumber} -> ${source}`);
        }
      }
    });
  }
}

const failures = [];

for (const manifestPath of manifests()) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = manifest[section];
    if (!dependencies || typeof dependencies !== 'object') {
      continue;
    }

    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof version !== 'string') {
        continue;
      }

      const normalizedVersion = version.trim();
      if (!normalizedVersion || normalizedVersion.startsWith('workspace:')) {
        continue;
      }

      if (hasBlockedManifestSource(normalizedVersion)) {
        failures.push(`${formatRelativePathForReport(manifestPath)} -> ${name}@${normalizedVersion}`);
      }
    }
  }
}

for (const lockfilePath of lockfiles()) {
  if (lockfilePath.endsWith('.yaml')) {
    validatePnpmLock(lockfilePath, failures);
    continue;
  }
  const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
  if (lockfile.packages && typeof lockfile.packages === 'object') {
    for (const [packagePath, packageMeta] of Object.entries(lockfile.packages)) {
      if (!packageMeta || typeof packageMeta !== 'object') {
        continue;
      }

      const source = lockPackageSource(packageMeta);
      if (!source) {
        continue;
      }

      const packageName = lockEntryName(packagePath, packageMeta);
      const allowed = (packageMeta.link === true && isWorkspaceLink(packageName, source)) || isRegistryTarball(source);

      if (!allowed) {
        failures.push(`${formatRelativePathForReport(lockfilePath)} -> ${packagePath || '(root)'} -> ${source}`);
      }
    }
  }

  for (const { dependencyPath, name, packageMeta } of collectLegacyLockEntries(lockfile.dependencies)) {
    const source = legacyLockSource(packageMeta);
    if (!source) {
      continue;
    }

    const allowed = (packageMeta.link === true && isWorkspaceLink(name, source)) || isRegistryTarball(source);

    if (!allowed) {
      failures.push(`${formatRelativePathForReport(lockfilePath)} -> ${dependencyPath} -> ${source}`);
    }
  }
}

if (failures.length > 0) {
  console.error('Disallowed dependency sources found:');
  for (const failure of failures) {
    console.error(` - ${failure}`);
  }
  process.exit(1);
}
