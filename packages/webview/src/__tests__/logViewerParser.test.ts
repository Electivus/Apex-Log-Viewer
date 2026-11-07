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

  // Every log line below was captured from a real org. Salesforce writes `|` as `&#124;` and no other character changes.
  describe('escaped pipes', () => {
    it('shows a debug message with the pipes the developer wrote and keeps the raw line as logged', () => {
      const raw = '10:14:58.51 (53050648)|USER_DEBUG|[1]|ERROR|order=42&#124;status=FAILED&#124;reason=x';

      expect(parseLogLines([raw])[0]).toMatchObject({
        type: 'USER_DEBUG',
        lineNumber: 1,
        message: 'ERROR | order=42|status=FAILED|reason=x',
        raw
      });
    });

    it('decodes only the pipe, so entity-like text and special characters stay as written', () => {
      const [special, entities, literal] = parseLogLines([
        `10:14:58.51 (53103180)|USER_DEBUG|[7]|ERROR|all=&#124;<>&"'`,
        '10:18:13.45 (47183104)|USER_DEBUG|[6]|ERROR|ENT=&#x7C;&vert;&#38;&#60;&#62;&#34;&#39;&#10;&amp;&lt;&gt;&quot;&apos;',
        '10:14:58.51 (53114875)|USER_DEBUG|[9]|ERROR|literal=&amp;#124;'
      ]);

      expect(special?.message).toBe(`ERROR | all=|<>&"'`);
      expect(entities?.message).toBe('ERROR | ENT=&#x7C;&vert;&#38;&#60;&#62;&#34;&#39;&#10;&amp;&lt;&gt;&quot;&apos;');
      expect(literal?.message).toBe('ERROR | literal=&amp;#124;');
    });

    it('keeps decoded pipes in one message instead of treating them as field separators', () => {
      const [spaced, only] = parseLogLines([
        '10:18:13.45 (704414472)|USER_DEBUG|[28]|ERROR|a &#124; spaced &#124; pipe',
        '10:18:13.45 (704406849)|USER_DEBUG|[27]|ERROR|&#124;'
      ]);

      expect(spaced).toMatchObject({ lineNumber: 28, message: 'ERROR | a | spaced | pipe' });
      expect(only).toMatchObject({ lineNumber: 27, message: 'ERROR | |' });
    });

    it('decodes the continuation lines of a debug message and keeps them raw in entry.raw', () => {
      const lines = ['10:14:58.51 (53992594)|USER_DEBUG|[14]|ERROR|{', '  "k&#124;1" : "v<2>&\\"\'"', '}'];

      expect(parseLogLines(lines)).toEqual([
        expect.objectContaining({
          message: ['ERROR | {', '  "k|1" : "v<2>&\\"\'"', '}'].join('\n'),
          raw: lines.join('\n')
        })
      ]);
    });

    it('decodes the message and details of other events', () => {
      const soqlLine = `10:19:25.120 (123654106)|SOQL_EXECUTE_BEGIN|[2]|Aggregations:0|SELECT Id FROM Account WHERE Name = 'lit&#124;<y>' LIMIT 1`;
      const [soql, variable] = parseLogLines([
        soqlLine,
        `10:19:25.120 (122769669)|VARIABLE_ASSIGNMENT|[1]|bound|"bound&#124;<v>&\\"'"`
      ]);

      expect(soql).toMatchObject({
        message: 'Aggregations:0',
        details: `SELECT Id FROM Account WHERE Name = 'lit|<y>' LIMIT 1`,
        raw: soqlLine
      });
      expect(variable?.message).toBe(`bound | "bound|<v>&\\"'"`);
    });

    it('decodes the second line of an exception, which the log also escapes', () => {
      const parsed = parseLogLines([
        '10:18:13.45 (706727119)|FATAL_ERROR|System.IllegalArgumentException: fatal&#124;one<a>',
        'second&#124;line&b'
      ]);

      expect(parsed.map(entry => entry.message)).toEqual([
        'System.IllegalArgumentException: fatal|one<a>',
        'second|line&b'
      ]);
      expect(parsed[1]?.raw).toBe('second&#124;line&b');
    });

    it('leaves the source echoed by Execute Anonymous as written, because the log does not escape it', () => {
      const source = "Execute Anonymous: String sourceLiteral = 'in-source=&#124;';";

      expect(parseLogLines([source])[0]?.message).toBe(source);
    });
  });
});
