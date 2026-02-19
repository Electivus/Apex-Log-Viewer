import assert from 'assert/strict';
import { highlightContent } from '../webview/utils/tail';

suite('highlightContent', () => {
  test('handles zero-length regex', () => {
    const rules = [{ regex: /(?:)/g, style: {} }];
    const segs = highlightContent('abc', rules);
    assert.equal(segs.length, 1);
    assert.equal(segs[0]?.text, 'abc');
  });
});
