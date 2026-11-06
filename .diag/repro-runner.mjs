import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const lan = Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal).address;
const targets = { loopback: ['127.0.0.1'], lan: [lan, '0.0.0.0'], hostname: [os.hostname(), '0.0.0.0'] };
const rounds = Number(process.env.DIAG_REPRO_ROUNDS ?? '80');
console.log(process.version, 'uv', process.versions.uv, 'lan', lan, 'hostname', os.hostname());
const env = { ...process.env };
delete env.http_proxy; delete env.HTTP_PROXY; delete env.HTTPS_PROXY; delete env.https_proxy;
for (const [name, args] of Object.entries(targets)) {
  let crashes = 0, other = 0, ok = 0;
  const started = Date.now();
  for (let r = 0; r < rounds; r++) {
    const run = spawnSync(process.execPath, [path.join(here, 'repro.mjs'), ...args], { env, encoding: 'utf8', timeout: 120000 });
    if (run.status === 3221226505) crashes++;
    else if (run.status === 0) ok++;
    else { other++; if (other < 3) console.log(name, 'status', run.status, run.signal, run.stderr.slice(-400)); }
  }
  console.log(`REPRO ${process.version} ${name}: rounds ${rounds}, crashed ${crashes}, ok ${ok}, other ${other}, ${Math.round((Date.now() - started) / 1000)} s`);
}
