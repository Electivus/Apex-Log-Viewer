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
});
