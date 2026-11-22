import assert from 'node:assert/strict';
import proxyquire from 'proxyquire';

type Redact = typeof import('../../../host/utils/redact');

const { redactSecrets } = proxyquire.noCallThru().noPreserveCache()('../../../host/utils/redact', {}) as Redact;

/** The characters a credential may hold: those of an RFC 6750 bearer token, the `!` of a session id, and `%`. */
const HELD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~+/=!%';

/** Every printable ASCII character, space, tab and newline that no credential holds. */
const ENDERS = [' ', '\t', '\n', '\r', ...Array.from({ length: 95 }, (_, index) => String.fromCharCode(0x20 + index))]
  .filter(character => !HELD.includes(character))
  .filter((character, index, all) => all.indexOf(character) === index);

/** The same seeded numbers on every run. */
function seeded(seed: number): (below: number) => number {
  return below => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % below;
  };
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

suite('where a credential the redaction replaces ends', () => {
  test('the error code after a credential and a character no credential holds stays, for every such character', () => {
    assert.deepEqual(
      ENDERS.filter(character => '&@:|#\\'.includes(character)).sort(),
      ['#', '&', ':', '@', '\\', '|'],
      'the characters of the #1534 report that end a credential are among those tried'
    );
    const pick = seeded(0x1534);
    const one = <T,>(items: readonly T[]): T => items[pick(items.length)] as T;
    const run = (alphabet: string, min: number, max: number) =>
      Array.from({ length: min + pick(max - min + 1) }, () => one([...alphabet])).join('');
    const credentials: Array<() => { prefix: string; value: string }> = [
      () => ({ prefix: pick(2) ? 'Bearer ' : 'sent ', value: `eyJ${run(B64URL, 8, 24)}.${run(B64URL, 8, 24)}.${run(B64URL, 8, 40)}` }),
      () => ({ prefix: 'Bearer ', value: `eyJ${run(B64URL, 8, 16)}==.${run(B64URL, 8, 16)}=.${run(B64URL, 8, 16)}` }),
      () => ({ prefix: pick(2) ? 'Bearer ' : 'sent ', value: `5Aep8${run(B64URL.replace('-', '.'), 20, 60)}` }),
      () => ({ prefix: 'Bearer ', value: `abcdefghijkl00D${run('0123456789', 12, 12)}!${run(B64URL.replace('-', '.'), 8, 40)}` })
    ];
    for (let index = 0; index < 4000; index++) {
      const { prefix, value } = one(credentials)();
      const tail = pick(3) ? '' : one(['%2F', '%TAIL', '~x', '==', '/x+y']);
      const ender = one(ENDERS);
      const code = `ERROR_CODE_${index}`;
      const text = `${prefix}${value}${tail}${ender}${code} end`;

      assert.equal(redactSecrets(text), `${prefix}[redacted]${ender}${code} end`, JSON.stringify(text));
    }
  });
});
