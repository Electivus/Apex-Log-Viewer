const test = require('node:test');
const assert = require('node:assert/strict');

const { buildWindowsQueryCommand } = require('./azure-monitor-helpers');

test('azJson quotes az arguments with spaces and cmd.exe metacharacters for cmd.exe on Windows', () => {
  const id = '/subscriptions/x/resourceGroups/R&D 100% ^!/providers/w';
  const probe = `
    const childProcess = require('node:child_process');
    const calls = [];
    childProcess.execFile = (file, args, options, callback) => {
      calls.push({ file, args, verbatim: !!options.windowsVerbatimArguments });
      callback(null, '{}', '');
    };
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.ComSpec = process.env.comspec = 'C:\\\\Windows\\\\System32\\\\cmd.exe';
    require(${JSON.stringify(require.resolve('./azure-monitor-helpers'))})
      .azJson(['monitor', 'log-analytics', 'workspace', 'show', '--ids', process.argv[1]])
      .then(() => process.stdout.write(JSON.stringify(calls)));
  `;
  const result = require('node:child_process').spawnSync(process.execPath, ['-e', probe, id], {
    encoding: 'utf8',
    env: { PATH: '' }
  });
  assert.equal(result.status, 0, result.stderr);

  assert.deepEqual(JSON.parse(result.stdout), [
    {
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '"az ^"monitor^" ^"log-analytics^" ^"workspace^" ^"show^" ^"--ids^" ' +
          '^"/subscriptions/x/resourceGroups/R^&D^ 100^%^ ^^^!/providers/w^" ^"-o^" ^"json^""'
      ],
      verbatim: true
    }
  ]);
});

test('azure-monitor-helpers loads without installed dependencies', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-azure-helpers-'));
  try {
    fs.copyFileSync(require.resolve('./azure-monitor-helpers'), path.join(directory, 'azure-monitor-helpers.js'));
    const result = require('node:child_process').spawnSync(
      process.execPath,
      ['-e', 'require(process.argv[1])', path.join(directory, 'azure-monitor-helpers.js')],
      { encoding: 'utf8', env: { PATH: process.env.PATH } }
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('buildWindowsQueryCommand keeps the KQL in environment variables instead of the shell command', () => {
  const plan = buildWindowsQueryCommand('workspace-123', "AppEvents | where Name == 'x'");

  assert.equal(plan.command, 'powershell.exe');
  assert.match(plan.args.join(' '), /\$env:ALV_AZ_WORKSPACE_ID/);
  assert.match(plan.args.join(' '), /\$env:ALV_AZ_KQL_QUERY/);
  assert.equal(plan.env.ALV_AZ_WORKSPACE_ID, 'workspace-123');
  assert.equal(plan.env.ALV_AZ_KQL_QUERY, "AppEvents | where Name == 'x'");
  assert.doesNotMatch(plan.args.join(' '), /AppEvents \| where Name == 'x'/);
});
