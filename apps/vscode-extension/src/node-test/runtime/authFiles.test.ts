import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Phase = {
  name: string;
  authFilesChanged: string[];
  writeAttempts: string[];
  errors: string[];
  sfCommands: string[];
};
type Outcome = { phases: Phase[]; rejectedRequests: number; acceptedAfterRenewal: number };

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');

/** Runs `authFilesScenario.ts` in a fresh process with a throwaway HOME and a fake `sf` of one CLI generation. */
function runScenario(generation: 'new' | 'old'): Outcome {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-auth-files-'));
  try {
    const home = path.join(dir, 'home');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SF_USE_GENERIC_UNIX_KEYCHAIN: 'true',
      SF_DISABLE_DNS_CHECK: 'true',
      SF_DISABLE_TELEMETRY: 'true',
      ALV_TEST_REPO_ROOT: repoRoot,
      ALV_TEST_FAKE_SF_GENERATION: generation,
      ALV_SF_BIN_PATH: path.join(bin, process.platform === 'win32' ? 'sf.cmd' : 'sf')
    };
    for (const name of ['SF_TARGET_ORG', 'SFDX_IGNORE_API_VERSION_CACHE', 'SF_ACCESS_TOKEN', 'SFDX_ACCESS_TOKEN']) {
      delete env[name];
    }
    const bootstrap = `require(${JSON.stringify(path.join(repoRoot, 'scripts', 'run-node-tests.js'))}).registerTypeScriptLoader(${JSON.stringify(repoRoot)}); require(${JSON.stringify(path.join(__dirname, 'authFilesScenario.ts'))});`;
    const child = spawnSync(process.execPath, ['-e', bootstrap], {
      cwd: home,
      env,
      encoding: 'utf8',
      timeout: 120_000
    });
    assert.equal(child.status, 0, `scenario exited ${child.status}: ${child.stderr}`);
    return JSON.parse(child.stdout.trim().split('\n').at(-1) ?? '{}') as Outcome;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The token commands a fake `sf` ran: the first use of the org, then one renewal after the rejection. */
const tokenCommands = {
  new: { first: ['org auth show-access-token'], renewal: ['org auth show-access-token'] },
  old: { first: ['org auth show-access-token', 'org display'], renewal: ['org display'] }
} as const;

const tokenCommandsOf = (phase: Phase): string[] => phase.sfCommands.filter(command => command !== 'org list auth');

suite('Salesforce auth files belong to the sf CLI', () => {
  for (const generation of ['new', 'old'] as const) {
    test(`extension operations never write ~/.sfdx or ~/.sf (${generation} sf CLI)`, function (this: Mocha.Context) {
      this.timeout(180_000);
      const outcome = runScenario(generation);
      const [valid, rejected] = outcome.phases;
      assert.ok(valid && rejected, 'the scenario reports both phases');

      assert.deepEqual(valid.errors, [], 'every operation succeeds with the stored session');
      assert.deepEqual(valid.writeAttempts, [], 'no write is attempted under ~/.sfdx or ~/.sf');
      assert.deepEqual(valid.authFilesChanged, [], 'auth file bytes and mtimes stay as sf left them');
      assert.deepEqual(tokenCommandsOf(valid), tokenCommands[generation].first, 'sf hands out the token once');

      assert.deepEqual(rejected.errors, [], 'every operation recovers after the org rejects the session');
      assert.ok(outcome.rejectedRequests > 0, 'the org rejected the old session at least once');
      assert.ok(outcome.acceptedAfterRenewal > 0, 'requests succeed with the session sf returns');
      assert.deepEqual(rejected.writeAttempts, [], 'renewal attempts no write under ~/.sfdx or ~/.sf');
      assert.deepEqual(
        tokenCommandsOf(rejected),
        tokenCommands[generation].renewal,
        'one renewal serves every operation'
      );
    });
  }
});
