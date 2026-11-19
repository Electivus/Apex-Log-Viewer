import { AsyncLocalStorage } from 'async_hooks';
import * as net from 'net';

const LOOPBACK_HOST = /^(localhost|::1?|0\.0\.0\.0|127\.\d+\.\d+\.\d+|::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4})$/;

/** Lower-cases the host, drops a trailing dot and IPv6 brackets, and compresses IPv6 to the form URL prints. */
function normalizeHost(host: string): string {
  const bare = host.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (!bare.includes(':')) {
    return bare;
  }
  try {
    return new URL(`http://[${bare}]`).hostname.slice(1, -1);
  } catch {
    return bare;
  }
}

/** The host and port a Socket#connect call dials over TCP, or undefined for an IPC path. */
function tcpTarget(args: unknown[]): { host: string; port: string } | undefined {
  // net.connect hands Socket#connect its normalized arguments as a single array.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: String(first) };
  }
  if (typeof first === 'string') {
    return undefined;
  }
  const options = (first ?? {}) as { path?: unknown; host?: unknown; port?: unknown };
  if (typeof options.path === 'string') {
    return undefined;
  }
  return { host: typeof options.host === 'string' ? options.host : 'localhost', port: String(options.port) };
}

type MochaRunnable = { prototype: { run(...args: unknown[]): unknown; fullTitle(): string } };

/**
 * Refuses every non-loopback TCP connection a unit test opens and returns the refused list. Each test runs
 * in an async context named after it, so work it leaves running still counts, while the VS Code test host's
 * own requests, which start outside every test, pass through. Integration tests may connect.
 */
export function installNetworkGuard(runnable: MochaRunnable): readonly string[] {
  const violations: string[] = [];
  const runningTest = new AsyncLocalStorage<string>();
  const run = runnable.prototype.run;
  runnable.prototype.run = function (this: { fullTitle(): string }, ...args: unknown[]): unknown {
    return runningTest.run(this.fullTitle(), () => run.apply(this, args));
  };
  const connect = net.Socket.prototype.connect as (this: net.Socket, ...args: unknown[]) => net.Socket;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
    const target = tcpTarget(args);
    const test = runningTest.getStore();
    if (!target || LOOPBACK_HOST.test(normalizeHost(target.host)) || test === undefined || test.startsWith('integration:')) {
      return connect.apply(this, args);
    }
    const endpoint = `${target.host}:${target.port}`;
    violations.push(`${test} -> ${endpoint}`);
    process.nextTick(() => this.destroy(new Error(`Unit tests may not open network connections (${endpoint}).`)));
    return this;
  } as typeof net.Socket.prototype.connect;
  return violations;
}
