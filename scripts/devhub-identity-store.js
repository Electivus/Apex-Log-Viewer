'use strict';

const spawn = require('cross-spawn');

function nativeGh(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => reject(new Error('GitHub credential-store operation failed; output withheld.')));
    child.on('close', code => {
      if (code !== 0) return reject(new Error('GitHub credential-store operation failed; output withheld.'));
      try {
        resolve(output.trim() ? JSON.parse(output) : undefined);
      } catch {
        reject(new Error('GitHub credential-store response is invalid; output withheld.'));
      }
    });
    child.stdin.end(input);
  });
}

function githubStore(lifecycle, invoke) {
  const match = /^github-actions-secret:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/SF_DEVHUB_PRIVATE_KEY$/.exec(
    lifecycle.storagePolicy
  );
  if (!match)
    throw new Error(
      'Rotation requires an explicit repository GitHub Actions Secret storage policy for SF_DEVHUB_PRIVATE_KEY.'
    );
  const repository = match[1];
  const run = async (args, options) => {
    try {
      return await invoke(args, options);
    } catch {
      throw new Error(
        'GitHub credential-store operation failed; output withheld. Preserve rotation state for recovery.'
      );
    }
  };
  return {
    repository,
    async replacePrivateKey(input) {
      await run(['secret', 'set', 'SF_DEVHUB_PRIVATE_KEY', '--repo', repository, '--app', 'actions'], { input });
    },
    async inspect() {
      const records = await run([
        'secret',
        'list',
        '--repo',
        repository,
        '--app',
        'actions',
        '--json',
        'name,updatedAt'
      ]);
      const required = ['CLIENT_ID', 'USERNAME', 'LOGIN_URL', 'PRIVATE_KEY'].map(name => `SF_DEVHUB_${name}`);
      if (
        !Array.isArray(records) ||
        required.some(
          name => records.filter(item => item.name === name && Number.isFinite(Date.parse(item.updatedAt))).length !== 1
        )
      )
        throw new Error('Approved GitHub Actions store must contain all four JWT inputs; values cannot be read back.');
      return records.filter(item => required.includes(item.name)).map(({ name, updatedAt }) => ({ name, updatedAt }));
    }
  };
}

module.exports = { nativeGh, githubStore };
