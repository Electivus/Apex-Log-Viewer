import * as fs from 'node:fs';
import * as path from 'node:path';

export function resolveBundledBinaryCandidates(baseDir: string, platform: string, arch: string): string[] {
  const target = `${platform}-${arch}`;
  const bin = platform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
  return [
    path.resolve(baseDir, '..', 'bin', target, bin),
    path.resolve(baseDir, '..', '..', 'bin', target, bin),
  ];
}

export function resolveBundledBinary(platform: string, arch: string): string {
  const candidates = resolveBundledBinaryCandidates(__dirname, platform, arch);
  return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0]!;
}
