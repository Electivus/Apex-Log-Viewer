const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  formatGitHubOutput,
  resolveVscodeCacheMetadata,
  sanitizeOutputValue
} = require('./resolve-vscode-cache-metadata');

test('resolveVscodeCacheMetadata returns fetched stable metadata when the update API succeeds', async () => {
  const metadata = await resolveVscodeCacheMetadata({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          productVersion: '1.113.0',
          version: 'commit-sha'
        };
      }
    })
  });

  assert.deepEqual(metadata, {
    build: 'commit-sha',
    version: '1.113.0'
  });
});

test('resolveVscodeCacheMetadata retries stable metadata fetches before falling back', async () => {
  let attempts = 0;

  const metadata = await resolveVscodeCacheMetadata({
    fetchImpl: async () => {
      attempts += 1;
      throw new Error(`temporary failure ${attempts}`);
    },
    sleepImpl: async () => {}
  });

  assert.equal(attempts, 3);
  assert.deepEqual(metadata, {
    build: 'stable',
    version: 'stable'
  });
});

test('resolveVscodeCacheMetadata uses a sanitized target for non-stable versions without fetching', async () => {
  let fetchCalls = 0;

  const metadata = await resolveVscodeCacheMetadata({
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('should not fetch');
    },
    target: ' insiders/latest '
  });

  assert.equal(fetchCalls, 0);
  assert.deepEqual(metadata, {
    build: 'insiders-latest',
    version: 'insiders-latest'
  });
});

test('formatGitHubOutput emits version and build lines for GitHub Actions', () => {
  assert.equal(formatGitHubOutput({ version: '1.113.0', build: 'commit-sha' }), 'version=1.113.0\nbuild=commit-sha\n');
});

test('sanitizeOutputValue normalizes blank or invalid output values to the fallback', () => {
  assert.equal(sanitizeOutputValue(' stable ', 'fallback'), 'stable');
  assert.equal(sanitizeOutputValue('   ', 'fallback'), 'fallback');
  assert.equal(sanitizeOutputValue('release/preview', 'fallback'), 'release-preview');
});

test('script entrypoint writes resolved metadata into GITHUB_OUTPUT', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-vscode-cache-meta-'));
  const githubOutputPath = path.join(tempDir, 'github-output.txt');

  try {
    const modulePath = require.resolve('./resolve-vscode-cache-metadata');
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        [
          "global.fetch = async () => ({",
          "  ok: true,",
          "  async json() {",
          "    return { productVersion: '1.114.0', version: 'stable-commit' };",
          '  }',
          '});',
          `require(${JSON.stringify(modulePath)}).main();`
        ].join('\n')
      ],
      {
        cwd: __dirname,
        env: {
          ...process.env,
          GITHUB_OUTPUT: githubOutputPath
        },
        encoding: 'utf8'
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(githubOutputPath, 'utf8'), 'version=1.114.0\nbuild=stable-commit\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
