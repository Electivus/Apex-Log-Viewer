import assert from 'assert/strict';
import { extractCodeUnitStartedFromLines } from '../salesforce/http';

suite('extractCodeUnitStartedFromLines', () => {
  test('extracts the last pipe-separated segment', () => {
    const lines = [
      '12:34:56.789 (1234)|EXECUTION_STARTED',
      '12:34:56.790 (2345)|CODE_UNIT_STARTED|[EXTERNAL]|01pXX0000000001|MyNamespace__MyController'
    ];
    const value = extractCodeUnitStartedFromLines(lines);
    assert.equal(value, 'MyNamespace__MyController');
  });

  test('returns undefined when not present', () => {
    const lines = ['12:34:56.789 (1234)|EXECUTION_STARTED', '12:34:56.790 (2345)|SOME_OTHER_EVENT|foo'];
    const value = extractCodeUnitStartedFromLines(lines);
    assert.equal(value, undefined);
  });

  test('trims whitespace and handles extra separators', () => {
    const lines = ['...|CODE_UNIT_STARTED|  foo | bar |  Baz  '];
    const value = extractCodeUnitStartedFromLines(lines);
    assert.equal(value, 'Baz');
  });
});
