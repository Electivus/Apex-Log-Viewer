import { parseLogLines } from '../utils/logViewerParser';

describe('logViewerParser', () => {
  it('keeps serializePretty continuation lines in their USER_DEBUG entry', () => {
    const parsed = parseLogLines([
      '12:00:00.000 (1)|USER_DEBUG|[7]|DEBUG|{',
      '  "account" : {',
      '    "name" : "Acme | Main"',
      '  }',
      '}',
      '12:00:01.000 (2)|METHOD_EXIT|[7]|Example.run()'
    ]);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      id: 0,
      category: 'debug',
      message: ['DEBUG | {', '  "account" : {', '    "name" : "Acme | Main"', '  }', '}'].join('\n')
    });
    expect(parsed[1]).toMatchObject({
      id: 5,
      category: 'system',
      message: 'Example.run()'
    });
  });

  it('keeps an Execute Anonymous source line containing pipes as plain text', () => {
    const source = "Execute Anonymous: System.debug(LoggingLevel.ERROR, 'order=42|status=FAILED|reason=x');";
    const parsed = parseLogLines([source, '12:00:00.000 (1)|EXECUTION_STARTED']);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ type: 'INFO', category: 'other', timestamp: '', message: source });
    expect(parsed[1]).toMatchObject({ type: 'EXECUTION_STARTED' });
  });

  it('does not count a pipe-bearing non-event line as an error event', () => {
    const parsed = parseLogLines([
      "Execute Anonymous: System.debug('a|FATAL_ERROR|b');",
      '12:00:00.000 (1)|FATAL_ERROR|boom'
    ]);

    expect(parsed.filter(entry => entry.category === 'error')).toHaveLength(1);
  });
});
