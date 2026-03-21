import assert from 'assert/strict';
import { promises as fs } from 'node:fs';
import proxyquire from 'proxyquire';
import type { PendingLaunchRequest, WorkspaceTarget } from '../shared/newWindowLaunch';
import { LAUNCH_REQUEST_TTL_MS, getPendingLaunchMarkerPath } from '../shared/newWindowLaunch';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

function createVscodeStub(workspace: { workspaceFile?: { toString: () => string }; workspaceFolders?: Array<{ uri: { toString: () => string } }> }) {
  return {
    workspace,
    Range: class {
      constructor(
        public readonly startLine: number,
        public readonly startCharacter: number,
        public readonly endLine: number,
        public readonly endCharacter: number
      ) {}
    }
  } as const;
}

type UpdateCall = {
  key: string;
  value: unknown;
};

type StorageFactory = {
  get: (key: string) => unknown;
  update: (key: string, value: unknown) => Promise<void>;
  updates: UpdateCall[];
  getStoreValue: (key: string) => unknown;
};

function createMemoryStorage(initial: Record<string, unknown>): StorageFactory {
  const values = new Map<string, unknown>(Object.entries(initial));
  const updates: UpdateCall[] = [];

  return {
    get: (key: string) => values.get(key),
    update: async (key: string, value: unknown) => {
      updates.push({ key, value });
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    },
    updates,
    getStoreValue: (key: string) => values.get(key)
  };
}

function createLaunchService(
  currentWorkspaceTarget: WorkspaceTarget | undefined,
  storage: StorageFactory,
  overrides: Record<string, unknown> = {}
) {
  const serviceModule = proxyquireStrict('../services/NewWindowLaunchService', {
    '../utils/workspace': {
      getCurrentWorkspaceTarget: () => currentWorkspaceTarget,
      workspaceTargetsEqual: (a: WorkspaceTarget | undefined, b: WorkspaceTarget | undefined) => {
        return Boolean(a && b && a.type === b.type && a.uri === b.uri);
      }
    }
  }) as typeof import('../services/NewWindowLaunchService');

  return new serviceModule.NewWindowLaunchService({ globalState: storage, ...overrides });
}

function makeBaseRequest(target: WorkspaceTarget): PendingLaunchRequest {
  return {
    version: 1,
    kind: 'logs',
    workspaceTarget: target,
    createdAt: Date.now(),
    nonce: 'nonce-001'
  };
}

function makeHandlerCalls() {
  const callOrder: string[] = [];
  return {
    callOrder,
    handlers: {
      restoreWindowContext: async ({ selectedOrg }: { selectedOrg?: string }) => {
        callOrder.push(`restore${selectedOrg ? `:${selectedOrg}` : ''}`);
      },
      openLogs: async () => {
        callOrder.push('logs');
      },
      openTail: async () => {
        callOrder.push('tail');
      },
      openDebugFlags: async () => {
        callOrder.push('flags');
      },
      openLogViewer: async () => {
        callOrder.push('viewer');
      }
    }
  };
}

suite('workspace target helpers', () => {
  test('builds a workspace-file target when workspace.workspaceFile exists', () => {
    const workspaceModule = proxyquireStrict('../utils/workspace', {
      vscode: createVscodeStub({
        workspaceFile: {
          toString: () => 'untitled:workspace.code-workspace'
        },
        workspaceFolders: [{ uri: { toString: () => 'file:///fallback' } }]
      })
    }) as typeof import('../utils/workspace');

    const target = workspaceModule.getCurrentWorkspaceTarget();

    assert.deepEqual(target, {
      type: 'workspaceFile',
      uri: 'untitled:workspace.code-workspace'
    });
  });

  test('builds folder target from first workspace folder when no workspace file exists', () => {
    const workspaceModule = proxyquireStrict('../utils/workspace', {
      vscode: createVscodeStub({
        workspaceFolders: [
          { uri: { toString: () => 'file:///workspace/first' } },
          { uri: { toString: () => 'file:///workspace/second' } }
        ]
      })
    }) as typeof import('../utils/workspace');

    const target = workspaceModule.getCurrentWorkspaceTarget();

    assert.deepEqual(target, {
      type: 'folder',
      uri: 'file:///workspace/first'
    });
  });
});

suite('NewWindowLaunchService', () => {
  const workspaceA: WorkspaceTarget = { type: 'folder', uri: 'file:///workspace' };
  const workspaceB: WorkspaceTarget = { type: 'folder', uri: 'file:///other-workspace' };

  test('consumes only a fresh request whose workspace target matches current window', async () => {
    const request = makeBaseRequest(workspaceA);
    const storage = createMemoryStorage({ pendingNewWindowLaunch: request });
    const clearLaunchMarkerCalls: string[] = [];
    const service = createLaunchService(workspaceA, storage, {
      waitForLaunchMarker: async () => true,
      clearLaunchMarker: async (nonce: string) => {
        clearLaunchMarkerCalls.push(nonce);
      }
    });
    const { callOrder, handlers } = makeHandlerCalls();

    await service.consumePendingLaunch(handlers);

    assert.deepEqual(callOrder, ['restore', 'logs']);
    assert.equal(storage.updates.length, 1);
    assert.deepEqual(storage.updates[0], { key: 'pendingNewWindowLaunch', value: undefined });
    assert.equal(storage.getStoreValue('pendingNewWindowLaunch'), undefined);
    assert.deepEqual(clearLaunchMarkerCalls, [request.nonce]);
  });

  test('clears stale requests without dispatching', async () => {
    const request: PendingLaunchRequest = {
      ...makeBaseRequest(workspaceA),
      createdAt: Date.now() - (LAUNCH_REQUEST_TTL_MS + 1000)
    };
    const storage = createMemoryStorage({ pendingNewWindowLaunch: request });
    const service = createLaunchService(workspaceA, storage);
    const { callOrder, handlers } = makeHandlerCalls();

    await service.consumePendingLaunch(handlers);

    assert.deepEqual(callOrder, []);
    assert.deepEqual(storage.updates, [{ key: 'pendingNewWindowLaunch', value: undefined }]);
    assert.equal(storage.getStoreValue('pendingNewWindowLaunch'), undefined);
  });

  test('clears malformed requests without dispatching', async () => {
    const storage = createMemoryStorage({
      pendingNewWindowLaunch: {
        version: 1,
        kind: 'logs',
        workspaceTarget: { type: 'folder', uri: 123 },
        createdAt: Date.now(),
        nonce: 'nonce-001'
      }
    });
    const service = createLaunchService(workspaceA, storage);
    const { callOrder, handlers } = makeHandlerCalls();

    await service.consumePendingLaunch(handlers);

    assert.deepEqual(callOrder, []);
    assert.deepEqual(storage.updates, [{ key: 'pendingNewWindowLaunch', value: undefined }]);
    assert.equal(storage.getStoreValue('pendingNewWindowLaunch'), undefined);
  });

  test('ignores workspace mismatches without dispatching or clearing the pending request', async () => {
    const request = makeBaseRequest(workspaceA);
    const storage = createMemoryStorage({ pendingNewWindowLaunch: request });
    const service = createLaunchService(workspaceB, storage);
    const { callOrder, handlers } = makeHandlerCalls();

    await service.consumePendingLaunch(handlers);

    assert.deepEqual(callOrder, []);
    assert.deepEqual(storage.updates, []);
    assert.deepEqual(storage.getStoreValue('pendingNewWindowLaunch'), request);
  });

  test('clears invalid logViewer requests without dispatching', async () => {
    const storage = createMemoryStorage({
      pendingNewWindowLaunch: {
        version: 1,
        kind: 'logViewer',
        workspaceTarget: workspaceA,
        createdAt: Date.now(),
        nonce: 'nonce-001',
        logId: '07L1234567890123'
      }
    });
    const service = createLaunchService(workspaceA, storage);
    const { callOrder, handlers } = makeHandlerCalls();

    await service.consumePendingLaunch(handlers);

    assert.deepEqual(callOrder, []);
    assert.deepEqual(storage.updates, [{ key: 'pendingNewWindowLaunch', value: undefined }]);
  });

  test('dispatch order is restoreWindowContext first, then matching surface handler', async () => {
    const request = makeBaseRequest(workspaceA);
    const storage = createMemoryStorage({ pendingNewWindowLaunch: request });
    const service = createLaunchService(workspaceA, storage, {
      waitForLaunchMarker: async () => true
    });
    const { callOrder, handlers } = makeHandlerCalls();

    await service.consumePendingLaunch(handlers);

    assert.deepEqual(callOrder, ['restore', 'logs']);
    assert.deepEqual(storage.updates, [{ key: 'pendingNewWindowLaunch', value: undefined }]);
  });

  test('dispatches logViewer with logId and filePath once context is restored', async () => {
    const request: PendingLaunchRequest = {
      version: 1,
      kind: 'logViewer',
      workspaceTarget: workspaceA,
      createdAt: Date.now(),
      nonce: 'viewer-001',
      logId: '07L9876543210987',
      filePath: '/tmp/sample.log'
    };

    const storage = createMemoryStorage({ pendingNewWindowLaunch: request });
    const service = createLaunchService(workspaceA, storage, {
      waitForLaunchMarker: async () => true
    });
    const { callOrder, handlers } = makeHandlerCalls();

    await service.consumePendingLaunch(handlers);

    assert.deepEqual(callOrder, ['restore', 'viewer']);
    assert.deepEqual(storage.updates, [{ key: 'pendingNewWindowLaunch', value: undefined }]);
    assert.equal(storage.getStoreValue('pendingNewWindowLaunch'), undefined);
  });

  test('launchInNewWindow opens the destination with a nonce-bound marker file', async () => {
    const storage = createMemoryStorage({});
    const openFolderCalls: Array<{ workspaceTarget: WorkspaceTarget; filesToOpen?: string[] }> = [];
    const service = createLaunchService(workspaceA, storage, {
      openFolder: async (workspaceTarget: WorkspaceTarget, options?: { filesToOpen?: string[] }) => {
        openFolderCalls.push({ workspaceTarget, filesToOpen: options?.filesToOpen });
      }
    });

    await service.launchInNewWindow({ kind: 'tail', workspaceTarget: workspaceA });

    const request = storage.getStoreValue('pendingNewWindowLaunch') as PendingLaunchRequest | undefined;
    assert.ok(request);
    const expectedMarkerPath = getPendingLaunchMarkerPath(request!.nonce);
    assert.deepEqual(openFolderCalls, [{ workspaceTarget: workspaceA, filesToOpen: [expectedMarkerPath] }]);
    await fs.unlink(expectedMarkerPath);
  });

  test('ignores same-workspace windows until the nonce-bound marker is present', async () => {
    const request = makeBaseRequest(workspaceA);
    const storage = createMemoryStorage({ pendingNewWindowLaunch: request });
    const service = createLaunchService(workspaceA, storage, {
      waitForLaunchMarker: async () => false
    });
    const { callOrder, handlers } = makeHandlerCalls();

    await service.consumePendingLaunch(handlers);

    assert.deepEqual(callOrder, []);
    assert.deepEqual(storage.updates, []);
    assert.deepEqual(storage.getStoreValue('pendingNewWindowLaunch'), request);
  });

  test('waits for the launch marker for the full remaining request TTL budget', async () => {
    const originalDateNow = Date.now;
    Date.now = () => 50_000;
    try {
      const request: PendingLaunchRequest = {
        ...makeBaseRequest(workspaceA),
        createdAt: 10_000,
        nonce: 'nonce-ttl-budget'
      };
      const storage = createMemoryStorage({ pendingNewWindowLaunch: request });
      const waitForLaunchMarkerCalls: Array<{ nonce: string; createdAt: number }> = [];
      const service = createLaunchService(workspaceA, storage, {
        waitForLaunchMarker: async (markerRequest: { nonce: string; createdAt: number }) => {
          waitForLaunchMarkerCalls.push(markerRequest);
          return false;
        }
      });
      const { callOrder, handlers } = makeHandlerCalls();

      await service.consumePendingLaunch(handlers);

      assert.deepEqual(callOrder, []);
      assert.equal(waitForLaunchMarkerCalls.length, 1);
      assert.equal(waitForLaunchMarkerCalls[0]?.nonce, 'nonce-ttl-budget');
      assert.equal(waitForLaunchMarkerCalls[0]?.createdAt, 10_000);
      assert.deepEqual(storage.updates, []);
      assert.deepEqual(storage.getStoreValue('pendingNewWindowLaunch'), request);
    } finally {
      Date.now = originalDateNow;
    }
  });
});
