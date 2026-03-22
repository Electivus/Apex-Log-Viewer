const test = require('node:test');
const assert = require('node:assert/strict');

const { buildWindowsQueryCommand } = require('./azure-monitor-helpers');

test('buildWindowsQueryCommand keeps the KQL in environment variables instead of the shell command', () => {
  const plan = buildWindowsQueryCommand('workspace-123', "AppEvents | where Name == 'x'");

  assert.equal(plan.command, 'powershell.exe');
  assert.match(plan.args.join(' '), /\$env:ALV_AZ_WORKSPACE_ID/);
  assert.match(plan.args.join(' '), /\$env:ALV_AZ_KQL_QUERY/);
  assert.equal(plan.env.ALV_AZ_WORKSPACE_ID, 'workspace-123');
  assert.equal(plan.env.ALV_AZ_KQL_QUERY, "AppEvents | where Name == 'x'");
  assert.doesNotMatch(plan.args.join(' '), /AppEvents \| where Name == 'x'/);
});
