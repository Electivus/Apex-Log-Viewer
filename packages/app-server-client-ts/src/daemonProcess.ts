import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { encodeJsonl, splitJsonl } from './jsonlRpc';

export interface DaemonProcess {
  readonly child: ChildProcessWithoutNullStreams;
  onMessage(listener: (message: unknown) => void): () => void;
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

  child.stdout.on('data', chunk => {
    const decoded = splitJsonl(`${rest}${chunk.toString('utf8')}`);
    rest = decoded.rest;

    for (const message of decoded.messages) {
      emitter.emit('message', message);
    }
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
