import assert from 'assert/strict';
import { apexLineStyle, categoryStyle, contentHighlightRules, parseApexLine } from '../webview/utils/tail';

type CssProps = Record<string, unknown>;

suite('tail utils', () => {
  suite('apexLineStyle', () => {
    test('returns neutral style when highlighting disabled', () => {
      const style = apexLineStyle('12:00:00.000 | USER_DEBUG | message', false);
      assert.deepEqual(style, { color: 'inherit' });
    });

    test('highlights fatal errors in error color with emphasis', () => {
      const style = apexLineStyle('12:00:00.000 | EXCEPTION_THROWN | FATAL_ERROR', true) as CssProps;
      assert.equal(style.color, 'var(--vscode-errorForeground)');
      assert.equal(style.fontWeight, 600);
    });

    test('identifies user debug, SOQL, and DML categories', () => {
      const debug = apexLineStyle('12:00:00.000|USER_DEBUG|DEBUG|message', true) as CssProps;
      const soql = apexLineStyle('SOQL_EXECUTE_BEGIN', true) as CssProps;
      const dml = apexLineStyle('DML_BEGIN', true) as CssProps;

      assert.equal(debug.color, 'var(--vscode-charts-blue)');
      assert.equal(soql.color, 'var(--vscode-charts-yellow)');
      assert.equal(dml.color, 'var(--vscode-charts-green)');
    });

    test('returns specialized styles for callouts, limits, and workflow markers', () => {
      const callout = apexLineStyle('12:00 | CALLOUT_', true) as CssProps;
      const limit = apexLineStyle('12:00 | LIMIT_USAGE', true) as CssProps;
      const workflow = apexLineStyle('FLOW_START | WORKFLOW', true) as CssProps;
      const validation = apexLineStyle('VALIDATION_RULE', true) as CssProps;

      assert.equal(callout.color, 'var(--vscode-charts-orange, #d19a66)');
      assert.equal(limit.color, 'var(--vscode-charts-orange, #d19a66)');
      assert.equal(workflow.color, 'var(--vscode-charts-blue, #2bbac5)');
      assert.equal(validation.color, '#ff79c6');
    });

    test('de-emphasizes system method markers', () => {
      const style = apexLineStyle('METHOD_ENTRY|', true) as CssProps;
      assert.equal(style.color, 'var(--vscode-descriptionForeground, #8a8a8a)');
    });
  });

  suite('parseApexLine', () => {
    test('extracts timestamp, elapsed nanos, and debug message tokens', () => {
      const parsed = parseApexLine('12:34:56.789 (120) | USER_DEBUG | DEBUG | value=42 | done');
      assert.equal(parsed.time, '12:34:56.789');
      assert.equal(parsed.nanos, '120');
      assert.equal(parsed.category, 'USER_DEBUG');
      assert.deepEqual(parsed.tokens, [' DEBUG ', ' value=42 ', ' done']);
      assert.equal(parsed.debugMessage, ' value=42 | done');
    });

    test('falls back when timestamp missing and preserves raw tokens', () => {
      const parsed = parseApexLine('NO_PREFIX | SOQL_EXECUTE | tokenA | tokenB');
      assert.equal(parsed.time, undefined);
      assert.equal(parsed.nanos, undefined);
      assert.equal(parsed.category, 'SOQL_EXECUTE');
      assert.deepEqual(parsed.tokens, [' tokenA ', ' tokenB']);
      assert.equal(parsed.debugMessage, undefined);
    });
  });

  suite('categoryStyle', () => {
    test('emphasizes fatal and limit categories distinctly', () => {
      const fatal = categoryStyle('EXCEPTION_THROWN', 'line with exception');
      const limit = categoryStyle('LIMIT_USAGE', 'limit line');
      assert.equal(fatal.color, 'var(--vscode-errorForeground)');
      assert.equal((fatal as CssProps).fontWeight, 600);
      assert.equal(limit.color, 'var(--vscode-charts-orange, #d19a66)');
    });

    test('detects workflow, debug, and method markers', () => {
      const debug = categoryStyle('USER_DEBUG', 'line');
      const workflow = categoryStyle('WF_RULE', 'line');
      const method = categoryStyle('METHOD_ENTRY', 'line');
      assert.equal(debug.color, 'var(--vscode-charts-blue)');
      assert.equal(workflow.color, 'var(--vscode-charts-purple, #ff7ee7)');
      assert.equal(method.color, 'var(--vscode-descriptionForeground, #8a8a8a)');
    });

    test('returns empty style when category missing', () => {
      assert.deepEqual(categoryStyle(undefined, 'line'), {});
    });
  });

  suite('contentHighlightRules', () => {
    test('includes rule that underlines email addresses for quick scanning', () => {
      const emailRule = contentHighlightRules.find(r => r.regex.source.includes('@'));
      assert.ok(emailRule, 'email rule should exist');
      emailRule!.regex.lastIndex = 0;
      assert.ok(emailRule!.regex.test('Contact admin at whisper@example.com for help'));
      assert.equal((emailRule!.style as CssProps).textDecoration, 'underline');
    });
  });
});
