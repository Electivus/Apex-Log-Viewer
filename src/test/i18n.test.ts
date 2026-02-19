import assert from 'assert/strict';
import { getMessages } from '../webview/i18n';

suite('i18n messages', () => {
  test('defaults to english and exposes expected keys', () => {
    const messages = getMessages(undefined);
    assert.equal(messages.refresh, 'Refresh');
    assert.equal(messages.tail?.debugTag, 'debug');
  });

  test('resolves Portuguese locales (pt and pt-BR) to translated copy', () => {
    const pt = getMessages('pt');
    const ptBr = getMessages('pt-BR');

    assert.equal(pt.refresh, 'Atualizar');
    assert.equal(pt.tail?.debugOnly, 'Somente USER_DEBUG');
    assert.equal(ptBr.tail?.waiting, 'Aguardando logs…');
  });
});
