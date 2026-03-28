import * as path from 'node:path';

export function resolveBundledBinary(platform: string, arch: string): string {
  const target = `${platform}-${arch}`;
  const bin = platform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
  return path.resolve(__dirname, '..', 'bin', target, bin);
}
