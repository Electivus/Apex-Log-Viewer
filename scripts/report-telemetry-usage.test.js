const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAdoptionFunnelQuery,
  buildCliErrorQuery,
  buildDeviceEventsQuery,
  buildOutcomeQuery,
  buildSearchCoverageQuery,
  buildWeeklyAdoptionQuery,
  formatAdoptionFunnel,
  parseDeviceList,
  parseMinVersion
} = require('./report-telemetry-usage');

test('buildOutcomeQuery materializes outcome before summarize', () => {
  const query = buildOutcomeQuery({
    componentResourceId: '/subscriptions/SUB/resourceGroups/RG/providers/Microsoft.Insights/components/APP',
    lookback: '30d'
  });

  assert.match(query, /\| extend props = parse_json\(Properties\)/);
  assert.match(query, /\| extend outcome = tostring\(props\['outcome'\]\)/);
  assert.match(query, /\| summarize events = sum\(coalesce\(tolong\(ItemCount\), 1\)\) by name = Name, outcome/);
  assert.doesNotMatch(query, /by name = Name, outcome = tostring/);
});

test('report queries use single-quoted KQL string literals', () => {
  const context = {
    componentResourceId: '/subscriptions/SUB/resourceGroups/RG/providers/Microsoft.Insights/components/APP',
    lookback: '30d'
  };

  assert.match(
    buildCliErrorQuery(context),
    /\| where Name in \('electivus\.apex-log-viewer\/cli\.exec', 'electivus\.apex-log-viewer\/cli\.getOrgAuth'\)/
  );
  assert.match(buildSearchCoverageQuery(context), /\| where Name contains 'search' or Name contains 'filter'/);
});

test('parseDeviceList splits a comma list and drops blanks', () => {
  assert.deepEqual(parseDeviceList(' a-1 , ,b-2,'), ['a-1', 'b-2']);
  assert.deepEqual(parseDeviceList(''), []);
});

test('device queries drop excluded devices and keep everyone when none are excluded', () => {
  const context = {
    componentResourceId: '/subscriptions/SUB/resourceGroups/RG/providers/Microsoft.Insights/components/APP',
    lookback: '90d'
  };

  assert.match(
    buildDeviceEventsQuery({ ...context, excludeDevices: ['dev-1', "dev'2"] }),
    /\| where device !in \('dev-1', 'dev''2'\)/
  );
  assert.doesNotMatch(buildDeviceEventsQuery({ ...context, excludeDevices: [] }), /device !in/);
  assert.match(buildAdoptionFunnelQuery({ ...context, excludeDevices: ['dev-1'] }), /\| where device !in \('dev-1'\)/);
  assert.match(buildWeeklyAdoptionQuery({ ...context, excludeDevices: ['dev-1'] }), /\| where device !in \('dev-1'\)/);
});

test('formatAdoptionFunnel reports each stage as a share of activated devices', () => {
  const lines = formatAdoptionFunnel({
    devices: 200,
    inProject: 180,
    acted: 100,
    loadedLogs: 50,
    triedLog: 20,
    appliedFlags: 10,
    returned: 30,
    dormant: 40,
    dormantSeenLast14d: 25
  });

  assert.equal(lines[0], 'Activated: 200, 180 of them in a Salesforce project');
  assert.equal(lines[1], 'Did something beyond activation (a view or a command): 100 (50%)');
  assert.equal(lines[4], 'Applied debug flags: 10 (5%)');
  assert.match(lines[6], /: 40, 25 of them seen in the last 14 days$/);
  assert.equal(
    formatAdoptionFunnel({ devices: 0, acted: 0 })[1],
    'Did something beyond activation (a view or a command): 0 (0%)'
  );
});

test('a minimum version keeps only events from that extension version on', () => {
  const context = {
    componentResourceId: '/subscriptions/SUB/resourceGroups/RG/providers/Microsoft.Insights/components/APP',
    lookback: '90d'
  };
  const versionFilter =
    /\| where parse_version\(tostring\(props\['common\.extversion'\]\)\) >= parse_version\('0\.56\.0'\)/;

  assert.match(buildAdoptionFunnelQuery({ ...context, minVersion: '0.56.0' }), versionFilter);
  assert.match(buildWeeklyAdoptionQuery({ ...context, minVersion: '0.56.0' }), versionFilter);
  assert.doesNotMatch(buildDeviceEventsQuery({ ...context, minVersion: '' }), /parse_version/);
});

test('parseMinVersion accepts dotted numbers and rejects anything else', () => {
  assert.equal(parseMinVersion('0.56.0'), '0.56.0');
  assert.equal(parseMinVersion('0.56'), '0.56');
  assert.equal(parseMinVersion(''), '');
  assert.throws(() => parseMinVersion('v0.56.0'), /--min-version must be a version such as 0\.56\.0, got "v0\.56\.0"/);
  assert.throws(() => parseMinVersion("0.56.0') or true"), /--min-version/);
});

test('dormant counts only the days a Salesforce project was open', () => {
  const query = buildAdoptionFunnelQuery({
    componentResourceId: '/subscriptions/SUB/resourceGroups/RG/providers/Microsoft.Insights/components/APP',
    lookback: '90d'
  });

  assert.match(
    query,
    /projectDays = dcountif\(startofday\(TimeGenerated\), event == 'extension\.activate' and tostring\(props\['hasSalesforceProject'\]\) == 'true'\)/
  );
  assert.match(query, /\| extend dormant = engagedDays == 0 and projectDays >= 5/);
  assert.match(query, /inProject = countif\(projectDays > 0\)/);
});
