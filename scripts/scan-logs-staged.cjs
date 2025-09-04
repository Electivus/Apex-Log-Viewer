#!/usr/bin/env node
// Heuristic scan for log-like content in staged files (no extension dependency)
// - Looks for ISO timestamps, common log levels, and Apex-specific markers
// - Skips binary files; samples up to MAX_BYTES for speed

const { execSync, spawnSync } = require('child_process');

const MAX_BYTES = 512 * 1024; // 512KB
const MAX_LINES = 2000;

function getStagedFiles() {
  const out = execSync('git diff --cached --name-only --diff-filter=ACM', {
    encoding: 'utf8',
  }).trim();
  if (!out) return [];
  return out.split('\n').filter(Boolean);
}

function readStaged(path) {
  const res = spawnSync('git', ['show', `:${path}`], { encoding: null });
  if (res.status !== 0) return null; // deleted/renamed or not readable
  return res.stdout || null;
}

function isBinary(buf) {
  if (!buf) return false;
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    const c = buf[i];
    if (c === 0) return true; // NUL byte
  }
  return false;
}

// Precompile regexes
const reTimestampStart = new RegExp(
  // ISO 8601 or common formats at start of line
  String.raw`^(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?|\d{4}/\d{2}/\d{2}[ T]\d{2}:\d{2}:\d{2})`
);
const reLevel = /\b(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b/; // common levels
const reApex = /(^|\|)(USER_DEBUG|EXECUTION_(?:STARTED|FINISHED)|CODE_UNIT_(?:STARTED|FINISHED)|SOQL_EXECUTE_(?:BEGIN|END)|DML_(?:BEGIN|END)|LIMIT_USAGE_FOR_NS|CUMULATIVE_LIMIT_USAGE|FATAL_ERROR|EXCEPTION_THROWN)(\||$)/;

function looksLikeLog(content) {
  const text = content.toString('utf8');
  const sample = text.slice(0, MAX_BYTES);
  const lines = sample.split(/\r?\n/).slice(0, MAX_LINES);
  if (lines.length === 0) return false;

  let tsStart = 0;
  let level = 0;
  let apex = 0;

  for (const ln of lines) {
    if (reTimestampStart.test(ln)) tsStart++;
    if (reLevel.test(ln)) level++;
    if (reApex.test(ln)) apex++;
  }

  const n = lines.length;
  const tsRatio = tsStart / n;
  // Heuristics:
  // - Apex markers: >= 2 lines
  // - OR timestamp-heavy and level markers present
  // - OR many lines start with timestamps (pure timestamped logs)
  if (apex >= 2) return true;
  if (tsStart >= 10) return true;
  if (tsRatio >= 0.1 && level >= 3) return true;
  return false;
}

function main() {
  const files = getStagedFiles();
  if (files.length === 0) process.exit(0);

  const flagged = [];
  for (const f of files) {
    // Fast path for typical log directories
    if (/\b(apexlogs|logs?)\b/.test(f)) {
      flagged.push(f);
      continue;
    }
    const buf = readStaged(f);
    if (!buf) continue;
    if (isBinary(buf)) continue;
    if (looksLikeLog(buf)) flagged.push(f);
  }

  if (flagged.length > 0) {
    const list = flagged.map((p) => `  - ${p}`).join('\n');
    console.error(
      `\n❌ Bloqueado: conteúdo com aparência de LOG detectado (sem depender da extensão).\n\nArquivos:\n${list}\n\nDica:\n- Mantenha logs fora do VCS (ex.: 'apexlogs/' já no .gitignore).\n- Desfaça a inclusão: git restore --staged <arquivo>\n- Se não for log, renomeie/ajuste conteúdo para evitar falso-positivo.\n`
    );
    process.exit(1);
  }
}

main();
