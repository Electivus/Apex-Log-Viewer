import {
  DOCS_SEARCH_QUERY,
  DOCS_TAIL_SEARCH_QUERY,
  buildDocsScenarioAnonymousApex,
  getDocsScenarioSeedSpecs,
  getDocsTailScenarioSpec,
  toDocsLogFileName
} from '../docsScenario';

describe('docsScenario helpers', () => {
  test('builds a rich anonymous Apex script for docs screenshots', () => {
    const script = buildDocsScenarioAnonymousApex({
      marker: 'ALV_DOCS_MARKER',
      scenarioLabel: 'Policy Renewal Intake',
      searchPhrase: DOCS_SEARCH_QUERY,
      extraDebugLines: ['Policy renewal quote priced', 'Policy renewal premium mismatch surfaced'],
      includeError: true
    });

    expect(script).toContain("String marker = 'ALV_DOCS_MARKER';");
    expect(script).toContain("String searchPhrase = 'policy renewal';");
    expect(script).toContain('FROM Case WHERE Subject LIKE');
    expect(script).toContain('insert caseRecord;');
    expect(script).toContain('update caseRecord;');
    expect(script).toContain('insert followUpTask;');
    expect(script.indexOf('Policy renewal quote priced')).toBeLessThan(script.indexOf("'policy renewal'"));
    expect(script).toContain('Policy renewal premium mismatch surfaced');
    expect(script).toContain('brokenContext.toString()');
  });

  test('returns the seeded docs scenarios in the expected shape', () => {
    const specs = getDocsScenarioSeedSpecs();

    expect(specs.map(spec => spec.key)).toEqual([
      'heroQuote',
      'heroHappyPath',
      'heroUnderwriting',
      'heroError',
      'heroBilling',
      'heroBroker',
      'heroNotice',
      'viewerRich'
    ]);
    expect(specs.every(spec => spec.searchPhrase === DOCS_SEARCH_QUERY)).toBe(true);
    expect(specs.some(spec => spec.includeError)).toBe(true);
  });

  test('returns the tail scenario with its own live-search phrase', () => {
    const tailSpec = getDocsTailScenarioSpec();

    expect(tailSpec.key).toBe('tailLive');
    expect(tailSpec.searchPhrase).toBe(DOCS_TAIL_SEARCH_QUERY);
    expect(tailSpec.includeError).toBe(false);
  });

  test('uses a neutral docs-prefixed filename for cached logs', () => {
    expect(toDocsLogFileName('07L000000000001AAA')).toBe('docs_07L000000000001AAA.log');
  });
});
