// How far a fresh file's mtime runs ahead of the clock @salesforce/core stamps auth writes with
// (performance.timeOrigin + performance.now()), and of Date.now(), on this runner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-clock-'));
const file = path.join(dir, 'probe.json');
const perfNs = () => BigInt(Math.round((performance.now() + performance.timeOrigin) * 1e6));
const rounds = Number(process.env.DIAG_CLOCK_ROUNDS ?? '4000');
const perf = [];
const date = [];
for (let i = 0; i < rounds; i++) {
  fs.writeFileSync(file, '{}');
  const p = perfNs();
  const d = BigInt(Date.now()) * 1_000_000n;
  const m = fs.statSync(file, { bigint: true }).mtimeNs;
  perf.push(Number(m - p) / 1e6);
  date.push(Number(m - d) / 1e6);
  if (i % 5 === 0) {
    const end = Date.now() + 3;
    while (Date.now() < end) {}
  }
}
fs.rmSync(dir, { recursive: true, force: true });
const summary = (name, xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const q = f => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
  const ahead = xs.filter(x => x > 0);
  return `${name}: mtime ahead in ${ahead.length}/${xs.length} samples; ahead by max ${sorted.at(-1).toFixed(3)} ms, p99 ${q(0.99).toFixed(3)}, p50 ${q(0.5).toFixed(3)}, min ${sorted[0].toFixed(3)} ms`;
};
console.log(`CLOCK ${process.platform} ${process.version} uv ${process.versions.uv}`);
console.log('CLOCK ' + summary('mtime - (timeOrigin+now)', perf));
console.log('CLOCK ' + summary('mtime - Date.now()       ', date));
