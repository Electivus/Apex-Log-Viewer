import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import proxyquire from 'proxyquire';

import type { CustomLogCaptureStateView } from '../../shared/customLogsTypes';

const extensionRoot = path.resolve(__dirname, '..', '..', '..');
const bundle = (file: string): Record<string, string> =>
  JSON.parse(readFileSync(path.join(extensionRoot, 'l10n', file), 'utf8'));

const holder = { surface: 'cli', pid: 1, host: 'h', since: '2026-01-01T00:00:00Z' } as const;
const SHOWN: Array<[CustomLogCaptureStateView, string]> = [
  [{ state: 'connecting' }, 'Connecting'],
  [{ state: 'standby', holder }, 'Standby'],
  [{ state: 'catchingUp', from: 'new' }, 'Catching up'],
  [{ state: 'live', basis: 'quiet' }, 'Live'],
  [{ state: 'reconnecting', attempt: 2, cause: 'transport' }, 'Reconnecting']
];
const HIDDEN: CustomLogCaptureStateView[] = [
  { state: 'stopped', outcome: 'aborted' },
  { state: 'failed', code: 'X', message: 'boom' }
];

function load() {
  const used: Array<{ key: string; message: string }> = [];
  const { presentCaptureStatus } = proxyquire.noCallThru().noPreserveCache()('../../host/customLogsCaptureStatus', {
    './utils/localize': {
      localize: (key: string, message: string, ...args: Array<string | number>) => {
        used.push({ key, message });
        return message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)]));
      }
    }
  }) as typeof import('../../host/customLogsCaptureStatus');
  return { presentCaptureStatus, used };
}

suite('Custom Logs capture status presentation', () => {
  test('names the source and the state of a running capture', () => {
    const { presentCaptureStatus } = load();

    for (const [capture, label] of SHOWN) {
      const view = presentCaptureStatus([{ sourceLabel: 'App events', capture }]);
      assert.equal(view.visible, true);
      assert.ok(
        view.visible && view.text.includes('App events') && view.text.endsWith(label),
        view.visible ? view.text : ''
      );
      assert.ok(view.visible && view.tooltip.includes('App events'));
    }
  });

  test('has no item without a capture, or once it stopped or failed', () => {
    const { presentCaptureStatus } = load();

    assert.deepEqual(presentCaptureStatus([]), { visible: false });
    for (const capture of HIDDEN) {
      assert.deepEqual(presentCaptureStatus([{ sourceLabel: 'App events', capture }]), { visible: false });
    }
  });

  test('reads the view and its editor tab on one source as one capture, and different ones as a count', () => {
    const { presentCaptureStatus } = load();
    const live: CustomLogCaptureStateView = { state: 'live', basis: 'quiet' };

    const shared = presentCaptureStatus([
      { sourceLabel: 'App events', capture: live },
      { sourceLabel: 'App events', capture: live }
    ]);
    assert.ok(shared.visible && shared.text.endsWith('App events · Live'), shared.visible ? shared.text : '');

    const two = presentCaptureStatus([
      { sourceLabel: 'App events', capture: live },
      { sourceLabel: 'Nebula events', capture: { state: 'catchingUp', from: 'new' } },
      { sourceLabel: 'Old events', capture: { state: 'stopped', outcome: 'aborted' } }
    ]);
    assert.ok(two.visible);
    assert.equal(two.visible && two.text, '$(broadcast) Custom Logs: 2 captures');
    assert.ok(two.visible && two.tooltip.startsWith('App events · Live\nNebula events · Catching up\n'));
  });

  test('every string it shows has a translation in the pt-BR bundle', () => {
    const { presentCaptureStatus, used } = load();
    for (const [capture] of SHOWN) {
      presentCaptureStatus([{ sourceLabel: 'App events', capture }]);
    }
    presentCaptureStatus(SHOWN.map(([capture], i) => ({ sourceLabel: `Source ${i}`, capture })));
    const en = bundle('bundle.l10n.json');
    const ptBr = bundle('bundle.l10n.pt-br.json');

    assert.ok(used.length > 0);
    for (const { message } of used) {
      assert.ok(en[message], `bundle.l10n.json has "${message}"; run pnpm run l10n:write`);
      assert.ok(ptBr[message] && ptBr[message] !== message, `bundle.l10n.pt-br.json translates "${message}"`);
    }
  });
});
