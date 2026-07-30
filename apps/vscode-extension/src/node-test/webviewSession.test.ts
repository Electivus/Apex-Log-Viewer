import assert from 'assert/strict';
import * as webviewSessionModule from '../provider/webviewSession';
import {
  WEBVIEW_SESSION_MAX_RETRIES,
  WEBVIEW_SESSION_MOUNT_DELAY_MS,
  WEBVIEW_SESSION_READY_TIMEOUT_MS,
  WEBVIEW_SESSION_RETRY_DELAY_MS,
  type WebviewSessionDiagnostic,
  type WebviewSessionHost,
  type WebviewSessionInbound,
  type WebviewSessionOptions
} from '../provider/webviewSession';
import { createWebviewSessionForTest, type WebviewSessionClock } from './webviewSessionTestSupport';

interface TestOutboundMessage {
  readonly value: string;
}

interface TestInboundMessage {
  readonly action: string;
}

interface TestTimer {
  readonly id: number;
  readonly runAt: number;
  readonly callback: () => void;
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    }
  };
}

class FakeClock implements WebviewSessionClock {
  private readonly timers = new Map<number, TestTimer>();
  private now = 0;
  private nextId = 1;

  setTimeout(callback: () => void, delayMs: number): { dispose(): void } {
    const timer: TestTimer = {
      id: this.nextId++,
      runAt: this.now + delayMs,
      callback
    };
    this.timers.set(timer.id, timer);
    return {
      dispose: () => {
        this.timers.delete(timer.id);
      }
    };
  }

  async advanceBy(delayMs: number): Promise<void> {
    const target = this.now + delayMs;
    while (true) {
      const next = [...this.timers.values()]
        .filter(timer => timer.runAt <= target)
        .sort((left, right) => left.runAt - right.runAt || left.id - right.id)[0];
      if (!next) {
        break;
      }
      this.timers.delete(next.id);
      this.now = next.runAt;
      next.callback();
      await this.flushMicrotasks();
    }
    this.now = target;
    await this.flushMicrotasks();
  }

  async flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}

class FakeHost implements WebviewSessionHost<TestOutboundMessage> {
  visible = true;
  readonly posted: TestOutboundMessage[] = [];
  readonly mountedGenerations: number[] = [];
  readonly postOutcomes: Array<boolean | Error | Promise<boolean>> = [];
  recoveryRequests = 0;
  recoverFromReadyTimeout: (remount: () => void) => void | Promise<void> = () => undefined;
  private readonly disposeListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(message: unknown) => void | Promise<void>>();
  private readonly visibilityListeners = new Set<(visible: boolean) => void>();

  readonly webview = {
    postMessage: async (message: TestOutboundMessage): Promise<boolean> => {
      this.posted.push(message);
      const outcome = this.postOutcomes.shift() ?? true;
      if (outcome instanceof Error) {
        throw outcome;
      }
      return outcome;
    },
    onDidReceiveMessage: (listener: (message: unknown) => void | Promise<void>) => {
      this.messageListeners.add(listener);
      return {
        dispose: () => {
          this.messageListeners.delete(listener);
        }
      };
    }
  };

  recoverAfterReadyTimeout(remount: () => void): void | Promise<void> {
    this.recoveryRequests += 1;
    return this.recoverFromReadyTimeout(remount);
  }

  onDidDispose(listener: () => void): { dispose(): void } {
    this.disposeListeners.add(listener);
    return {
      dispose: () => {
        this.disposeListeners.delete(listener);
      }
    };
  }

  onDidChangeVisibility(listener: (visible: boolean) => void): { dispose(): void } {
    this.visibilityListeners.add(listener);
    return {
      dispose: () => {
        this.visibilityListeners.delete(listener);
      }
    };
  }

  emitMessage(message: unknown): void {
    for (const listener of [...this.messageListeners]) {
      void listener(message);
    }
  }

  disposeHost(): void {
    for (const listener of [...this.disposeListeners]) {
      listener();
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const listener of [...this.visibilityListeners]) {
      listener(visible);
    }
  }
}

interface SessionHarness {
  readonly clock: FakeClock;
  readonly diagnostics: WebviewSessionDiagnostic[];
  readonly host: FakeHost;
  readonly receivedActions: string[];
  readonly options: WebviewSessionOptions<TestOutboundMessage, TestInboundMessage, FakeHost>;
}

function createHarness(): SessionHarness {
  const clock = new FakeClock();
  const diagnostics: WebviewSessionDiagnostic[] = [];
  const host = new FakeHost();
  const receivedActions: string[] = [];
  const options: WebviewSessionOptions<TestOutboundMessage, TestInboundMessage, FakeHost> = {
    mount: (boundHost, generation) => {
      boundHost.mountedGenerations.push(generation);
    },
    getReplaySnapshot: () => [],
    validateInbound: (raw): WebviewSessionInbound<TestInboundMessage> | undefined => {
      if (!raw || typeof raw !== 'object') {
        return undefined;
      }
      const candidate = raw as { type?: unknown; generation?: unknown; action?: unknown };
      if (candidate.type === 'ready') {
        return {
          kind: 'ready',
          ...(typeof candidate.generation === 'number' ? { generation: candidate.generation } : {})
        };
      }
      if (candidate.type === 'action' && typeof candidate.action === 'string') {
        return { kind: 'message', message: { action: candidate.action } };
      }
      return undefined;
    },
    onMessage: message => {
      receivedActions.push(message.action);
    },
    onDiagnostic: diagnostic => {
      diagnostics.push(diagnostic);
    }
  };
  return { clock, diagnostics, host, receivedActions, options };
}

suite('Webview Session', () => {
  test('keeps clock construction out of the surface-facing module', () => {
    assert.ok(!('createWebviewSessionWithClock' in webviewSessionModule));
  });

  test('mounts a visible host after the default delay', async () => {
    const harness = createHarness();
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);

    assert.deepEqual(harness.host.mountedGenerations, []);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS - 1);
    assert.deepEqual(harness.host.mountedGenerations, []);

    await harness.clock.advanceBy(1);
    assert.deepEqual(harness.host.mountedGenerations, [1]);
  });

  test('ignores readiness until the current mount has completed', async () => {
    const harness = createHarness();
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    harness.host.emitMessage({ type: 'ready', generation: 0 });
    await harness.clock.flushMicrotasks();

    assert.equal(session.ready, false);
    assert.deepEqual(harness.host.posted, []);
    assert.ok(harness.diagnostics.some(diagnostic => diagnostic.event === 'staleWorkIgnored'));
  });

  test('consumes current readiness and replays the latest snapshot once', async () => {
    const harness = createHarness();
    let snapshotVersion = 1;
    let replaySuccesses = 0;
    harness.options.getReplaySnapshot = () => [{ value: `snapshot-${snapshotVersion}` }];
    harness.options.onReplaySucceeded = () => {
      replaySuccesses += 1;
    };
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    snapshotVersion = 2;
    harness.host.emitMessage({ type: 'ready', generation: 1 });
    await harness.clock.flushMicrotasks();

    assert.equal(session.ready, true);
    assert.deepEqual(harness.host.posted, [{ value: 'snapshot-2' }]);
    assert.equal(replaySuccesses, 1);
  });

  test('runs the surface ready workflow once after the initial snapshot is accepted', async () => {
    const harness = createHarness();
    const events: string[] = [];
    harness.options.getReplaySnapshot = () => {
      events.push('snapshot');
      return [{ value: 'snapshot' }];
    };
    harness.host.webview.postMessage = async message => {
      events.push(`posted:${message.value}`);
      return true;
    };
    harness.options.onReady = () => {
      events.push('ready-workflow');
    };
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    harness.host.emitMessage({ type: 'ready', generation: 1 });
    await harness.clock.flushMicrotasks();
    harness.host.emitMessage({ type: 'ready', generation: 1 });
    await harness.clock.flushMicrotasks();

    assert.deepEqual(events, ['snapshot', 'posted:snapshot', 'ready-workflow']);
  });

  test('treats duplicate readiness for the current mount as a no-op', async () => {
    const harness = createHarness();
    harness.options.getReplaySnapshot = () => [{ value: 'snapshot' }];
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    harness.host.emitMessage({ type: 'ready', generation: 1 });
    await harness.clock.flushMicrotasks();
    harness.host.emitMessage({ type: 'ready', generation: 1 });
    await harness.clock.flushMicrotasks();

    assert.equal(session.ready, true);
    assert.deepEqual(harness.host.posted, [{ value: 'snapshot' }]);
    assert.equal(harness.diagnostics.filter(diagnostic => diagnostic.event === 'readyDuplicate').length, 1);
  });

  test('forwards validated surface messages once and rejects invalid input', async () => {
    const harness = createHarness();
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    harness.host.emitMessage({ type: 'action', action: 'refresh' });
    harness.host.emitMessage({ type: 'action', action: 42 });
    await harness.clock.flushMicrotasks();

    assert.deepEqual(harness.receivedActions, ['refresh']);
  });

  test('diagnoses surface callback failure without changing readiness', async () => {
    const harness = createHarness();
    harness.options.onMessage = async () => {
      throw new Error('surface workflow failed');
    };
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    harness.host.emitMessage({ type: 'ready', generation: 1 });
    await harness.clock.flushMicrotasks();
    harness.host.emitMessage({ type: 'action', action: 'refresh' });
    await harness.clock.flushMicrotasks();

    assert.equal(session.ready, true);
    assert.ok(
      harness.diagnostics.some(diagnostic => diagnostic.event === 'callbackFailed' && diagnostic.callback === 'message')
    );
  });

  test('keeps a ready hidden host mounted and replays the latest snapshot when visible', async () => {
    const harness = createHarness();
    let snapshotValue = 'initial';
    harness.options.getReplaySnapshot = () => [{ value: snapshotValue }];
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    harness.host.emitMessage({ type: 'ready', generation: 1 });
    await harness.clock.flushMicrotasks();
    harness.host.posted.length = 0;

    harness.host.setVisible(false);
    snapshotValue = 'latest';
    const accepted = await session.deliver({ value: 'hidden-update' }, 'replayable');
    harness.host.setVisible(true);
    await harness.clock.flushMicrotasks();

    assert.equal(accepted, true);
    assert.equal(session.ready, true);
    assert.deepEqual(harness.host.mountedGenerations, [1]);
    assert.deepEqual(harness.host.posted, [{ value: 'hidden-update' }, { value: 'latest' }]);
  });

  test('preserves hidden replay intent created during an older in-flight snapshot', async () => {
    const harness = createHarness();
    const startupSnapshot = deferred<readonly TestOutboundMessage[]>();
    let snapshotCalls = 0;
    harness.options.getReplaySnapshot = () => {
      snapshotCalls += 1;
      return snapshotCalls === 1 ? startupSnapshot.promise : [{ value: 'latest' }];
    };
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    harness.host.emitMessage({ type: 'ready', generation: 1 });
    await harness.clock.flushMicrotasks();
    harness.host.setVisible(false);
    await session.deliver({ value: 'hidden-update' }, 'replayable');

    startupSnapshot.resolve([{ value: 'startup-snapshot' }]);
    await harness.clock.flushMicrotasks();
    harness.host.setVisible(true);
    await harness.clock.flushMicrotasks();

    assert.deepEqual(harness.host.posted, [{ value: 'hidden-update' }, { value: 'latest' }]);
  });

  test('reconverges when an older replay completes after a newer replay', async () => {
    const harness = createHarness();
    const olderSnapshot = deferred<readonly TestOutboundMessage[]>();
    let snapshotCalls = 0;
    harness.options.getReplaySnapshot = () => {
      snapshotCalls += 1;
      return snapshotCalls === 1 ? olderSnapshot.promise : [{ value: 'latest' }];
    };
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    harness.host.emitMessage({ type: 'ready', generation: 1 });
    await harness.clock.flushMicrotasks();
    harness.host.setVisible(false);
    await session.deliver({ value: 'hidden-update' }, 'replayable');
    harness.host.setVisible(true);
    await harness.clock.flushMicrotasks();

    olderSnapshot.resolve([{ value: 'older-snapshot' }]);
    await harness.clock.flushMicrotasks();
    await harness.clock.advanceBy(WEBVIEW_SESSION_RETRY_DELAY_MS);

    assert.deepEqual(harness.host.posted, [{ value: 'hidden-update' }, { value: 'latest' }, { value: 'latest' }]);
  });

  test('retries a rejected replayable delivery with the latest all-accepted snapshot', async () => {
    const harness = createHarness();
    let snapshotVersion = 1;
    harness.options.getReplaySnapshot = () => [
      { value: `snapshot-${snapshotVersion}-a` },
      { value: `snapshot-${snapshotVersion}-b` }
    ];
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    harness.options.getReplaySnapshot = () => [];
    harness.host.emitMessage({ type: 'ready', generation: 1 });
    await harness.clock.flushMicrotasks();
    harness.options.getReplaySnapshot = () => [
      { value: `snapshot-${snapshotVersion}-a` },
      { value: `snapshot-${snapshotVersion}-b` }
    ];
    harness.host.posted.length = 0;
    harness.host.postOutcomes.push(false, true, false, true, true);

    const accepted = await session.deliver({ value: 'update' }, 'replayable');
    snapshotVersion = 2;
    await harness.clock.advanceBy(WEBVIEW_SESSION_RETRY_DELAY_MS);
    snapshotVersion = 3;
    await harness.clock.advanceBy(WEBVIEW_SESSION_RETRY_DELAY_MS);
    await harness.clock.advanceBy(WEBVIEW_SESSION_RETRY_DELAY_MS * 2);

    assert.equal(accepted, false);
    assert.deepEqual(harness.host.posted, [
      { value: 'update' },
      { value: 'snapshot-2-a' },
      { value: 'snapshot-2-b' },
      { value: 'snapshot-3-a' },
      { value: 'snapshot-3-b' }
    ]);
  });

  test('bounds immediate retries but remains eligible on a future visibility transition', async () => {
    const harness = createHarness();
    harness.options.getReplaySnapshot = () => [];
    const session = createWebviewSessionForTest(harness.options, harness.clock);
    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    harness.host.emitMessage({ type: 'ready', generation: 1 });
    await harness.clock.flushMicrotasks();
    harness.options.getReplaySnapshot = () => [{ value: 'latest' }];
    harness.host.posted.length = 0;
    harness.host.postOutcomes.push(false, false, false, false, false, false, false, true);

    await session.deliver({ value: 'update' }, 'replayable');
    await harness.clock.advanceBy(WEBVIEW_SESSION_RETRY_DELAY_MS * 4);

    assert.deepEqual(harness.host.posted, [
      { value: 'update' },
      { value: 'latest' },
      { value: 'latest' },
      { value: 'latest' }
    ]);
    assert.ok(harness.diagnostics.some(diagnostic => diagnostic.event === 'retryExhausted'));

    harness.host.setVisible(false);
    harness.host.setVisible(true);
    await harness.clock.flushMicrotasks();
    await harness.clock.advanceBy(WEBVIEW_SESSION_RETRY_DELAY_MS * 4);

    assert.equal(
      harness.diagnostics.filter(diagnostic => diagnostic.event === 'retryAttempted').length,
      WEBVIEW_SESSION_MAX_RETRIES * 2
    );
    assert.equal(harness.host.posted.length, 8);
    assert.deepEqual(harness.host.posted.at(-1), { value: 'latest' });
  });

  test('retains replay intent when snapshot production fails', async () => {
    const harness = createHarness();
    let snapshotAttempts = 0;
    harness.options.getReplaySnapshot = () => {
      snapshotAttempts += 1;
      if (snapshotAttempts === 1) {
        throw new Error('snapshot unavailable');
      }
      return [{ value: 'recovered-latest' }];
    };
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    harness.host.emitMessage({ type: 'ready', generation: 1 });
    await harness.clock.flushMicrotasks();

    assert.equal(session.ready, true);
    assert.ok(
      harness.diagnostics.some(
        diagnostic => diagnostic.event === 'callbackFailed' && diagnostic.callback === 'snapshot'
      )
    );

    await harness.clock.advanceBy(WEBVIEW_SESSION_RETRY_DELAY_MS);
    assert.deepEqual(harness.host.posted, [{ value: 'recovered-latest' }]);
  });

  test('requests capability-based recovery after the default ready timeout', async () => {
    const harness = createHarness();
    harness.host.recoverFromReadyTimeout = remount => {
      remount();
    };
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    await harness.clock.advanceBy(WEBVIEW_SESSION_READY_TIMEOUT_MS - 1);
    assert.equal(harness.host.recoveryRequests, 0);

    await harness.clock.advanceBy(1);
    assert.equal(harness.host.recoveryRequests, 1);
    assert.deepEqual(harness.host.mountedGenerations, [1]);
    assert.ok(harness.diagnostics.some(diagnostic => diagnostic.event === 'recoveryRequested'));
    assert.ok(!harness.diagnostics.some(diagnostic => diagnostic.event === ('readyTimeout' as never)));

    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    assert.deepEqual(harness.host.mountedGenerations, [1, 2]);
  });

  test('ignores stale timeout recovery that completes after rebinding', async () => {
    const harness = createHarness();
    const recovery = deferred<void>();
    harness.host.recoverFromReadyTimeout = async remount => {
      await recovery.promise;
      remount();
    };
    const replacement = new FakeHost();
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    await harness.clock.advanceBy(WEBVIEW_SESSION_READY_TIMEOUT_MS);
    assert.equal(harness.host.recoveryRequests, 1);

    session.bind(replacement);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    assert.deepEqual(replacement.mountedGenerations, [2]);

    recovery.resolve();
    await harness.clock.flushMicrotasks();
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS * 2);

    assert.deepEqual(harness.host.mountedGenerations, [1]);
    assert.deepEqual(replacement.mountedGenerations, [2]);
    assert.ok(harness.diagnostics.some(diagnostic => diagnostic.event === 'staleWorkIgnored'));
  });

  test('temporarily detaches on host disposal and rebinds with retained replay intent', async () => {
    const harness = createHarness();
    let detachNotifications = 0;
    harness.options.getReplaySnapshot = () => [{ value: 'latest' }];
    harness.options.onDetach = () => {
      detachNotifications += 1;
    };
    const replacement = new FakeHost();
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    harness.host.emitMessage({ type: 'ready', generation: 1 });
    await harness.clock.flushMicrotasks();
    harness.host.disposeHost();

    assert.equal(session.ready, false);
    assert.equal(detachNotifications, 1);
    assert.equal(await session.deliver({ value: 'while-detached' }, 'replayable'), false);

    session.bind(replacement);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    replacement.emitMessage({ type: 'ready', generation: 2 });
    await harness.clock.flushMicrotasks();

    assert.equal(session.ready, true);
    assert.deepEqual(replacement.mountedGenerations, [2]);
    assert.deepEqual(replacement.posted, [{ value: 'latest' }]);
  });

  test('reports why a host detached without exposing host-specific policy', () => {
    const harness = createHarness();
    const reasons: string[] = [];
    harness.options.onDetach = reason => {
      reasons.push(reason);
    };
    const replacement = new FakeHost();
    const explicit = new FakeHost();
    const final = new FakeHost();
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    session.bind(replacement);
    replacement.disposeHost();
    session.bind(explicit);
    session.detach();
    session.bind(final);
    session.dispose();

    assert.deepEqual(reasons, ['rebind', 'hostDisposed', 'explicit', 'finalDispose']);
  });

  test('ignores a stale delivery result after rebinding to a replacement host', async () => {
    const harness = createHarness();
    harness.options.getReplaySnapshot = () => [{ value: 'latest' }];
    const replacement = new FakeHost();
    const staleResult = deferred<boolean>();
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    harness.host.emitMessage({ type: 'ready', generation: 1 });
    await harness.clock.flushMicrotasks();
    harness.host.postOutcomes.push(staleResult.promise);
    const pendingDelivery = session.deliver({ value: 'old-update' }, 'replayable');

    session.bind(replacement);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    replacement.emitMessage({ type: 'ready', generation: 2 });
    await harness.clock.flushMicrotasks();
    replacement.posted.length = 0;

    staleResult.resolve(true);
    const accepted = await pendingDelivery;
    await harness.clock.advanceBy(WEBVIEW_SESSION_RETRY_DELAY_MS);

    assert.equal(accepted, false);
    assert.deepEqual(replacement.posted, []);
    assert.ok(harness.diagnostics.some(diagnostic => diagnostic.event === 'staleWorkIgnored'));
  });

  test('coalesces an asynchronous replay to a newer authoritative delivery', async () => {
    const harness = createHarness();
    harness.options.getReplaySnapshot = () => [];
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    harness.host.emitMessage({ type: 'ready', generation: 1 });
    await harness.clock.flushMicrotasks();

    const staleSnapshot = deferred<readonly TestOutboundMessage[]>();
    let snapshotCalls = 0;
    harness.options.getReplaySnapshot = () => {
      snapshotCalls += 1;
      return snapshotCalls === 1 ? staleSnapshot.promise : [{ value: 'latest-authoritative' }];
    };
    harness.host.posted.length = 0;
    harness.host.postOutcomes.push(false, true, true);

    assert.equal(await session.deliver({ value: 'trigger-replay' }, 'replayable'), false);
    await harness.clock.advanceBy(WEBVIEW_SESSION_RETRY_DELAY_MS);
    assert.equal(await session.deliver({ value: 'newer-direct' }, 'replayable'), true);

    staleSnapshot.resolve([{ value: 'stale-snapshot' }]);
    await harness.clock.flushMicrotasks();
    await harness.clock.advanceBy(WEBVIEW_SESSION_RETRY_DELAY_MS);

    assert.deepEqual(harness.host.posted, [
      { value: 'trigger-replay' },
      { value: 'newer-direct' },
      { value: 'latest-authoritative' }
    ]);
    assert.ok(harness.diagnostics.some(diagnostic => diagnostic.event === 'replaySuperseded'));
  });

  test('does not deliver a stale snapshot callback after rebinding', async () => {
    const harness = createHarness();
    const staleSnapshot = deferred<readonly TestOutboundMessage[]>();
    let snapshotCalls = 0;
    harness.options.getReplaySnapshot = () => {
      snapshotCalls += 1;
      return snapshotCalls === 1 ? staleSnapshot.promise : [{ value: 'replacement-latest' }];
    };
    const replacement = new FakeHost();
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    harness.host.emitMessage({ type: 'ready', generation: 1 });
    await harness.clock.flushMicrotasks();

    session.bind(replacement);
    staleSnapshot.resolve([{ value: 'stale-snapshot' }]);
    await harness.clock.flushMicrotasks();
    assert.deepEqual(harness.host.posted, []);

    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    replacement.emitMessage({ type: 'ready', generation: 2 });
    await harness.clock.flushMicrotasks();
    assert.deepEqual(replacement.posted, [{ value: 'replacement-latest' }]);
    assert.ok(harness.diagnostics.some(diagnostic => diagnostic.event === 'staleWorkIgnored'));
  });

  test('ignores completion of a stale surface message callback after rebinding', async () => {
    const harness = createHarness();
    const callback = deferred<void>();
    harness.options.onMessage = () => callback.promise;
    const replacement = new FakeHost();
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    harness.host.emitMessage({ type: 'action', action: 'refresh' });
    await harness.clock.flushMicrotasks();
    session.bind(replacement);

    callback.resolve();
    await harness.clock.flushMicrotasks();

    assert.ok(harness.diagnostics.some(diagnostic => diagnostic.event === 'staleWorkIgnored'));
    assert.ok(!harness.diagnostics.some(diagnostic => diagnostic.event === 'messageForwarded'));
  });

  test('rejects stale and ambiguous readiness after a replacement mount', async () => {
    const harness = createHarness();
    const replacement = new FakeHost();
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    session.detach();
    session.bind(replacement);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);

    replacement.emitMessage({ type: 'ready', generation: 1 });
    replacement.emitMessage({ type: 'ready' });
    await harness.clock.flushMicrotasks();
    assert.equal(session.ready, false);
    assert.ok(harness.diagnostics.some(diagnostic => diagnostic.event === 'staleWorkIgnored'));

    replacement.emitMessage({ type: 'ready', generation: 2 });
    await harness.clock.flushMicrotasks();
    assert.equal(session.ready, true);
  });

  test('waits for an initially hidden host to become visible before mounting', async () => {
    const harness = createHarness();
    harness.host.visible = false;
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS * 2);
    assert.deepEqual(harness.host.mountedGenerations, []);

    harness.host.setVisible(true);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    assert.deepEqual(harness.host.mountedGenerations, [1]);
  });

  test('pauses readiness timing when a mount completes while hidden', async () => {
    const harness = createHarness();
    const mountCompletion = deferred<void>();
    harness.options.mount = async (host, generation) => {
      host.mountedGenerations.push(generation);
      await mountCompletion.promise;
    };
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    harness.host.setVisible(false);
    mountCompletion.resolve();
    await harness.clock.flushMicrotasks();
    await harness.clock.advanceBy(WEBVIEW_SESSION_READY_TIMEOUT_MS);
    assert.equal(harness.host.recoveryRequests, 0);

    harness.host.setVisible(true);
    await harness.clock.advanceBy(WEBVIEW_SESSION_READY_TIMEOUT_MS);
    assert.equal(harness.host.recoveryRequests, 1);
  });

  test('final disposal cancels pending work and makes rebinding terminal', async () => {
    const harness = createHarness();
    const replacement = new FakeHost();
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    session.dispose();
    session.bind(replacement);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS * 2);

    assert.equal(session.ready, false);
    assert.deepEqual(harness.host.mountedGenerations, []);
    assert.deepEqual(replacement.mountedGenerations, []);
    assert.ok(harness.diagnostics.some(diagnostic => diagnostic.event === 'disposed'));
  });

  test('diagnoses inbound validation failure without routing the raw message', async () => {
    const harness = createHarness();
    harness.options.validateInbound = () => {
      throw new Error('validator failed');
    };
    const session = createWebviewSessionForTest(harness.options, harness.clock);

    session.bind(harness.host);
    harness.host.emitMessage({ token: 'do-not-record' });
    await harness.clock.flushMicrotasks();

    assert.equal(session.ready, false);
    assert.deepEqual(harness.receivedActions, []);
    assert.ok(
      harness.diagnostics.some(
        diagnostic => diagnostic.event === 'callbackFailed' && diagnostic.callback === 'validateInbound'
      )
    );
    assert.ok(!JSON.stringify(harness.diagnostics).includes('do-not-record'));
  });

  test('does not retain or retry a rejected transient delivery', async () => {
    const harness = createHarness();
    harness.options.getReplaySnapshot = () => [];
    const session = createWebviewSessionForTest(harness.options, harness.clock);
    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    harness.host.emitMessage({ type: 'ready', generation: 1 });
    await harness.clock.flushMicrotasks();
    harness.host.postOutcomes.push(false);

    assert.equal(await session.deliver({ value: 'transient' }, 'transient'), false);
    await harness.clock.advanceBy(WEBVIEW_SESSION_RETRY_DELAY_MS * 4);

    assert.deepEqual(harness.host.posted, [{ value: 'transient' }]);
    assert.ok(
      harness.diagnostics.some(
        diagnostic => diagnostic.event === 'deliveryRejected' && diagnostic.classification === 'transient'
      )
    );
  });

  test('reports metadata-only lifecycle, delivery, retry, and replay diagnostics', async () => {
    const harness = createHarness();
    harness.options.getReplaySnapshot = () => [];
    const session = createWebviewSessionForTest(harness.options, harness.clock);
    session.bind(harness.host);
    await harness.clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    harness.host.emitMessage({ type: 'ready', generation: 1 });
    await harness.clock.flushMicrotasks();
    harness.host.setVisible(false);
    harness.host.setVisible(true);
    harness.host.postOutcomes.push(false);
    await session.deliver({ value: 'secret-log-body' }, 'replayable');
    await harness.clock.advanceBy(WEBVIEW_SESSION_RETRY_DELAY_MS);
    session.detach();
    session.dispose();

    const events = new Set(harness.diagnostics.map(diagnostic => diagnostic.event));
    for (const event of [
      'attached',
      'mountScheduled',
      'mounted',
      'ready',
      'hidden',
      'visible',
      'deliveryAttempted',
      'deliveryRejected',
      'retryScheduled',
      'retryAttempted',
      'replaySucceeded',
      'detached',
      'disposed'
    ] as const) {
      assert.ok(events.has(event), `expected diagnostic event ${event}`);
    }
    const mountScheduled = harness.diagnostics.find(diagnostic => diagnostic.event === 'mountScheduled');
    const mounted = harness.diagnostics.find(diagnostic => diagnostic.event === 'mounted');
    const ready = harness.diagnostics.find(diagnostic => diagnostic.event === 'ready');
    assert.equal(mountScheduled?.mountTimerActive, true);
    assert.equal(mountScheduled?.contentMounted, false);
    assert.equal(mounted?.mountTimerActive, false);
    assert.equal(mounted?.readyTimerActive, true);
    assert.equal(mounted?.contentMounted, true);
    assert.equal(ready?.readyTimerActive, false);
    assert.equal(ready?.contentMounted, true);
    assert.ok(!JSON.stringify(harness.diagnostics).includes('secret-log-body'));
  });
});
