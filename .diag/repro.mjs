import { createServer } from 'node:http';
const host = process.argv[2];
const bind = process.argv[3] ?? host;
for (let i = 0; i < 84; i++) {
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{}');
    });
  });
  await new Promise(resolve => server.listen(0, bind, resolve));
  const { port } = server.address();
  const res = await fetch(`http://${host}:${port}/x`, { signal: AbortSignal.timeout(30000) });
  await res.text();
  await new Promise((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
}
