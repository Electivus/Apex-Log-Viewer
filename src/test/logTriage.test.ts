import assert from 'assert/strict';
import proxyquire from 'proxyquire';

suite('logTriage', () => {
  test('summarizeLogFile keeps parser triage enabled after a file read failure', async () => {
    const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();
    const parserCalls: string[] = [];
    const warnings: string[] = [];
    let readFileCalls = 0;
    const fallbackChunks = ['12:00:00.000 | USER_DEBUG | [6] | all good\n'];

    function createFallbackHandle(text: string) {
      const pending = [Buffer.from(text, 'utf8')];
      return {
        async read(buffer: Buffer) {
          const chunk = pending.shift();
          if (!chunk) {
            return { bytesRead: 0, buffer };
          }
          chunk.copy(buffer, 0);
          return { bytesRead: chunk.length, buffer };
        },
        async close() {}
      };
    }

    const logTriageModule: typeof import('../services/logTriage') = proxyquireStrict('../services/logTriage', {
      'node:module': {
        createRequire: () => () => ({
          summarizeLog(logText: string) {
            parserCalls.push(logText);
            return {
              hasErrors: true,
              primaryReason: 'Fatal exception',
              reasons: [
                {
                  code: 'fatal_exception',
                  severity: 'error',
                  summary: 'Fatal exception',
                  line: 1,
                  eventType: 'EXCEPTION_THROWN'
                }
              ]
            };
          }
        }),
        '@noCallThru': true
      },
      'node:fs': {
        promises: {
          async readFile() {
            readFileCalls += 1;
            if (readFileCalls === 1) {
              const error = new Error('file disappeared');
              (error as NodeJS.ErrnoException).code = 'ENOENT';
              throw error;
            }
            return 'plain text without heuristic markers';
          },
          async open() {
            return createFallbackHandle(fallbackChunks.shift() ?? '');
          }
        },
        '@noCallThru': true
      },
      '../utils/logger': {
        logWarn: (...args: unknown[]) => {
          warnings.push(args.map(String).join(' '));
        },
        '@noCallThru': true
      }
    });

    const firstSummary = await logTriageModule.summarizeLogFile('missing.log');
    const secondSummary = await logTriageModule.summarizeLogFile('healthy.log');

    assert.equal(firstSummary.hasErrors, false);
    assert.equal(secondSummary.hasErrors, true);
    assert.equal(secondSummary.primaryReason, 'Fatal exception');
    assert.equal(parserCalls.length, 1, 'parser-backed triage should still be used after a read failure');
    assert.equal(warnings.length, 0, 'file read failures should not disable the parser helper');
  });
});
