const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCliErrorQuery, buildOutcomeQuery, buildSearchCoverageQuery } = require('./report-telemetry-usage');

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
