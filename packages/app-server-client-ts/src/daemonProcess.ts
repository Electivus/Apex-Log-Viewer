import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { JsonlDecodeError, encodeJsonl, splitJsonl } from './jsonlRpc';

const DAEMON_ERROR_EVENT = 'daemon-error';

export interface DaemonProcess {
  readonly child: ChildProcessWithoutNullStreams;
  onMessage(listener: (message: unknown) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
  writeMessage(message: unknown): void;
  dispose(): void;
}

export function createDaemonProcess(executable: string, args: string[] = ['app-server', '--stdio']): DaemonProcess {
  const child = spawn(executable, args, {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const emitter = new EventEmitter();
  let rest = '';
  const emitDaemonError = (error: Error) => {
    emitter.emit(DAEMON_ERROR_EVENT, error);
  };

  child.stdout.on('data', chunk => {
    const decoded = splitJsonl(`${rest}${chunk.toString('utf8')}`);
    rest = decoded.rest;

    for (const message of decoded.messages) {
      emitter.emit('message', message);
    }

    const firstError = decoded.errors[0];
    if (firstError) {
      emitDaemonError(
        new Error(`runtime exited (protocol error: ${formatJsonlDecodeError(firstError)})`)
      );
      if (!child.killed) {
        child.kill();
      }
    }
  });

  child.on('error', error => {
    emitDaemonError(new Error(`runtime exited (process error: ${error.message})`));
  });

  child.on('exit', (code, signal) => {
    emitter.emit('exit', code, signal);
  });

  return {
    child,
    onMessage(listener) {
      emitter.on('message', listener);
      return () => emitter.off('message', listener);
    },
    onError(listener) {
      emitter.on(DAEMON_ERROR_EVENT, listener);
      return () => emitter.off(DAEMON_ERROR_EVENT, listener);
    },
    onExit(listener) {
      emitter.on('exit', listener);
      return () => emitter.off('exit', listener);
    },
    writeMessage(message) {
      child.stdin.write(encodeJsonl(message));
    },
    dispose() {
      if (!child.killed) {
        child.kill();
      }
    }
  };
}

function formatJsonlDecodeError(error: JsonlDecodeError): string {
  return `${error.message}; frame=${JSON.stringify(error.frame)}`;
}
