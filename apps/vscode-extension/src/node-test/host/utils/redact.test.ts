import assert from 'node:assert/strict';
import proxyquire from 'proxyquire';

type Redact = typeof import('../../../host/utils/redact');

/** A fresh `redact.ts`, with nothing held. */
const freshRedact = (): Redact => proxyquire.noCallThru().noPreserveCache()('../../../host/utils/redact', {});

/** `length` letters that no hex digit is, the same on every run. */
function syntheticLetters(length: number): string {
  const letters = 'GHIJKLMNOPQRSTUVWXYZghijklmnopqrstuvwxyz';
  let seed = 7;
  return Array.from({ length }, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return letters[seed % letters.length];
  }).join('');
}

const percentEncoded = (text: string): string =>
  [...text].map(character => `%${character.charCodeAt(0).toString(16)}`).join('');

suite('held token search', () => {
  test('1,025 held tokens are looked for in a percent-encoded text with moves that grow linearly with the text', () => {
    const letters = syntheticLetters(1040);
    const redact = freshRedact();
    for (let length = 12; length < 12 + 1024; length++) redact.holdSecret(letters.slice(0, length));
    redact.holdSecret('FAKE-0123456789abcdefABCDEF%');
    redact.redactSecrets('builds the finder');

    const moves = [128, 256, 512, 1024].map(count => {
      const text = percentEncoded(letters.slice(0, count));
      const before = redact.automatonMoves();
      assert.equal(
        redact.redactSecrets(text),
        '[redacted]',
        `${text.length} characters: the encoded token is replaced`
      );
      return { length: text.length, moves: redact.automatonMoves() - before };
    });

    for (const { length, moves: made } of moves) {
      assert.ok(made <= 4 * length, `${length} characters took ${made} moves`);
    }
    for (let index = 1; index < moves.length; index++) {
      const growth = moves[index]!.moves / moves[index - 1]!.moves;
      assert.ok(
        growth < 2.5,
        `doubling the text to ${moves[index]!.length} characters multiplied the moves by ${growth}`
      );
    }
  });
});
