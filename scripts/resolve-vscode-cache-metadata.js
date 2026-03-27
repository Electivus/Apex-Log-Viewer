#!/usr/bin/env node
'use strict';

const { appendFileSync } = require('node:fs');

function sanitizeOutputValue(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-');
  return normalized || fallback;
}

function formatGitHubOutput(metadata) {
  return `version=${metadata.version}\nbuild=${metadata.build}\n`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchStableMetadata(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is unavailable');
  }

  const response = await fetchImpl(
    `https://update.code.visualstudio.com/api/update/${options.platform}/stable/latest`
  );
  if (!response || response.ok === false) {
    const status = response && typeof response.status !== 'undefined' ? `status ${response.status}` : 'request failed';
    throw new Error(`VS Code metadata lookup failed (${status})`);
  }

  const payload = await response.json();
  return {
    build: sanitizeOutputValue(payload && (payload.version || payload.hash || payload.productVersion), 'stable'),
    version: sanitizeOutputValue(payload && (payload.productVersion || payload.name), 'stable')
  };
}

async function resolveVscodeCacheMetadata(options = {}) {
  const target = sanitizeOutputValue(options.target || process.env.VSCODE_TARGET || 'stable', 'stable');
  if (target !== 'stable') {
    return { build: target, version: target };
  }

  const logger = options.logger || console;
  const platform = sanitizeOutputValue(options.platform || process.env.VSCODE_PLATFORM || 'linux-x64', 'linux-x64');
  const maxAttempts = Number.isInteger(options.maxAttempts) ? options.maxAttempts : 3;
  const sleepImpl = options.sleepImpl || sleep;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchStableMetadata({
        fetchImpl: options.fetchImpl,
        platform
      });
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleepImpl(attempt * 2_000);
      }
    }
  }

  logger.warn(
    `[ci] Falling back to '${target}' for VS Code cache metadata after ${maxAttempts} failed attempt(s): ${
      lastError && lastError.message ? lastError.message : lastError
    }`
  );
  return { build: target, version: target };
}

async function main(options = {}) {
  const env = options.env || process.env;
  const metadata = await resolveVscodeCacheMetadata({
    fetchImpl: options.fetchImpl,
    logger: options.logger,
    maxAttempts: options.maxAttempts,
    platform: env.VSCODE_PLATFORM,
    sleepImpl: options.sleepImpl,
    target: env.VSCODE_TARGET
  });

  const output = formatGitHubOutput(metadata);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, output, 'utf8');
  } else if (options.stdout && typeof options.stdout.write === 'function') {
    options.stdout.write(output);
  } else {
    process.stdout.write(output);
  }

  return metadata;
}

if (require.main === module) {
  main().catch(error => {
    console.error(
      '[ci] Failed to resolve VS Code cache metadata:',
      error && error.message ? error.message : error
    );
    process.exit(1);
  });
}

module.exports = {
  formatGitHubOutput,
  main,
  resolveVscodeCacheMetadata,
  sanitizeOutputValue
};
