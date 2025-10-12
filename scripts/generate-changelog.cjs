#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

async function run() {
  const changelogPath = path.resolve(process.cwd(), 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    fs.writeFileSync(changelogPath, '# Changelog\n\n');
  }

  const cliPath = require.resolve('conventional-changelog-cli/cli.js');
  const args = [
    cliPath,
    '-p',
    'conventionalcommits',
    '-i',
    'CHANGELOG.md',
    '-s',
    '--release-count',
    '1'
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: 'inherit'
    });

    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`conventional-changelog exited with code ${code}`));
        return;
      }
      resolve();
    });
  });

  const raw = fs.readFileSync(changelogPath, 'utf8');
  const header = '# Changelog';
  const idx = raw.indexOf(header);
  let body;
  if (idx === -1) {
    body = raw.trim();
  } else {
    const before = raw.slice(0, idx);
    const after = raw.slice(idx + header.length);
    body = `${before}${after}`.trim();
  }
  const normalized = body ? `${header}\n\n${body}\n` : `${header}\n\n`;
  fs.writeFileSync(changelogPath, normalized);
}

run().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
