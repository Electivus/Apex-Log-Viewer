import { focusSnippet, splitOperation } from '../utils/logsCells';

describe('splitOperation', () => {
  it('keeps the last path segment apart so it can stay readable', () => {
    expect(splitOperation('/services/data/v60.0/tooling/executeAnonymous')).toEqual({
      head: '/services/data/v60.0/tooling/',
      tail: 'executeAnonymous'
    });
  });

  it('splits a single leading slash', () => {
    expect(splitOperation('/aura')).toEqual({ head: '/', tail: 'aura' });
  });

  it('treats a value without a slash as all head', () => {
    expect(splitOperation('ApexTestHandler')).toEqual({ head: 'ApexTestHandler', tail: '' });
    expect(splitOperation('')).toEqual({ head: '', tail: '' });
  });

  it('ignores a trailing slash when it looks for the last segment', () => {
    expect(splitOperation('/services/apexrest/Orders/')).toEqual({
      head: '/services/apexrest/',
      tail: 'Orders/'
    });
  });

  it('joins back to the original value', () => {
    const operation = '/services/data/v60.0/sobjects/Account/describe';
    const { head, tail } = splitOperation(operation);
    expect(head + tail).toBe(operation);
  });
});

describe('focusSnippet', () => {
  const context = 'x'.repeat(60);

  it('cuts the leading context so the first hit starts near the left edge', () => {
    const text = `...${context}NEEDLE and the rest of the line`;
    const hit: [number, number] = [63, 69];
    const focused = focusSnippet(text, [hit]);
    expect(focused.text.startsWith('…')).toBe(true);
    const [start, end] = focused.ranges[0]!;
    expect(focused.text.slice(start, end)).toBe('NEEDLE');
    expect(start).toBe(17);
  });

  it('shifts every range by the same amount', () => {
    const text = `${context}one two`;
    const focused = focusSnippet(text, [
      [60, 63],
      [64, 67]
    ]);
    expect(focused.ranges.map(([s, e]) => focused.text.slice(s, e))).toEqual(['one', 'two']);
  });

  it('returns a short snippet or one without hits as it is', () => {
    expect(focusSnippet('abc NEEDLE', [[4, 10]])).toEqual({ text: 'abc NEEDLE', ranges: [[4, 10]] });
    expect(focusSnippet(context, [])).toEqual({ text: context, ranges: [] });
  });
});
