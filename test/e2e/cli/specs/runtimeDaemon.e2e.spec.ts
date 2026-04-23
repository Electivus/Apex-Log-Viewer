import { access } from 'node:fs/promises';
import path from 'node:path';
import { createDaemonProcess, type DaemonProcess } from '../../../../packages/app-server-client-ts/src/daemonProcess';
import { expect, test } from '../fixtures/alvCliE2E';

type JsonRpcResponse = {
  id?: string;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

let nextRuntimeRequestId = 0;

function resolveRuntimeExecutable(): string {
  const binary = process.platform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
  return path.join(process.cwd(), 'target', 'debug', binary);
}

function redactedProxySummary(): Record<string, boolean> {
  return {
    HTTP_PROXY: Boolean(process.env.HTTP_PROXY || process.env.http_proxy),
    HTTPS_PROXY: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy),
    NO_PROXY: Boolean(process.env.NO_PROXY || process.env.no_proxy)
  };
}

function waitForRuntimeResponse(daemon: DaemonProcess, id: string, timeoutMs = 120_000): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanupCallbacks: Array<() => void> = [];
    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for runtime response '${id}'.`));
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      for (const callback of cleanupCallbacks) {
        callback();
      }
    }

    function finish(error: Error | undefined, response?: JsonRpcResponse): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      resolve(response as JsonRpcResponse);
    }

    cleanupCallbacks.push(
      daemon.onMessage(message => {
        const response = message as JsonRpcResponse;
        if (response?.id === id) {
          finish(undefined, response);
        }
      })
    );
    cleanupCallbacks.push(
      daemon.onError(error => {
        finish(error);
      })
    );
    cleanupCallbacks.push(
      daemon.onExit((code, signal) => {
        finish(new Error(`Runtime daemon exited before response '${id}' (code=${code}, signal=${signal}).`));
      })
    );
  });
}

async function sendRuntimeRequest<TResult>(
  daemon: DaemonProcess,
  method: string,
  params?: Record<string, unknown>
): Promise<TResult> {
  const id = `runtime-proxy-${++nextRuntimeRequestId}`;
  daemon.writeMessage({
    jsonrpc: '2.0',
    id,
    method,
    params: params || {}
  });

  const response = await waitForRuntimeResponse(daemon, id);
  if (response.error) {
    const data = response.error.data === undefined ? '' : ` data=${JSON.stringify(response.error.data)}`;
    throw new Error(`Runtime ${method} failed (${response.error.code ?? 'unknown'}): ${response.error.message}${data}`);
  }
  return response.result as TResult;
}

test('app-server daemon logs/list works through the standard corporate proxy env', async ({ scratchAlias, seededLog }, testInfo) => {
  const executable = resolveRuntimeExecutable();
  await expect(access(executable)).resolves.toBeUndefined();

  await testInfo.attach('runtime-proxy-env.json', {
    body: Buffer.from(JSON.stringify(redactedProxySummary(), null, 2), 'utf8'),
    contentType: 'application/json'
  });

  const daemon = createDaemonProcess(executable, ['app-server', '--stdio'], {
    env: { ...process.env }
  });

  try {
    const auth = await sendRuntimeRequest<{ username?: string; instanceUrl?: string }>(daemon, 'org/auth', {
      username: scratchAlias
    });
    expect(auth.username).toBeTruthy();
    expect(auth.instanceUrl).toMatch(/^https?:\/\//);

    const rows = await sendRuntimeRequest<Array<{ Id?: string }>>(daemon, 'logs/list', {
      username: scratchAlias,
      limit: 100
    });

    expect(Array.isArray(rows)).toBe(true);
    expect(rows.some(row => row.Id === seededLog.logId)).toBe(true);
  } finally {
    daemon.dispose();
  }
});
