#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { createCoverageMap } = require('istanbul-lib-coverage');
const { createContext } = require('istanbul-lib-report');
const reports = require('istanbul-reports');

const rootDir = path.resolve(__dirname, '..');
const coverageDir = path.join(rootDir, 'coverage');
const sources = [
  { name: 'extension', file: path.join(coverageDir, 'extension', 'coverage-final.json') },
  { name: 'webview', file: path.join(coverageDir, 'webview', 'coverage-final.json') }
];

const coverageMap = createCoverageMap({});
let mergedAny = false;

for (const source of sources) {
  if (!fs.existsSync(source.file)) {
    console.warn(
      `[coverage-merge] skipped missing ${source.name} coverage file: ${path.relative(rootDir, source.file)}`
    );
    continue;
  }
  const raw = fs.readFileSync(source.file, 'utf8');
  try {
    coverageMap.merge(JSON.parse(raw));
    mergedAny = true;
    console.log(`[coverage-merge] merged ${source.name} coverage (${path.relative(rootDir, source.file)})`);
  } catch (err) {
    console.error(`[coverage-merge] failed to parse ${source.file}:`, err);
    process.exitCode = 1;
    return;
  }
}

if (!mergedAny) {
  console.warn('[coverage-merge] no coverage inputs detected; nothing to merge.');
  process.exit(0);
}

fs.mkdirSync(coverageDir, { recursive: true });
const mergedJsonPath = path.join(coverageDir, 'coverage-final.json');
fs.writeFileSync(mergedJsonPath, JSON.stringify(coverageMap.toJSON(), null, 2));
console.log(`[coverage-merge] wrote merged JSON to ${path.relative(rootDir, mergedJsonPath)}`);

const context = createContext({ dir: coverageDir, coverageMap });
const reporterConfigs = [
  { type: 'json-summary' },
  { type: 'json' },
  { type: 'lcovonly' },
  { type: 'html', options: { skipEmpty: false } }
];

for (const { type, options } of reporterConfigs) {
  reports.create(type, options).execute(context);
  console.log(`[coverage-merge] emitted ${type} report`);
}

console.log('[coverage-merge] combined coverage reports are ready. Relatório consolidado:');
reports
  .create('text', { skipEmpty: false, skipFull: false })
  .execute(context);
