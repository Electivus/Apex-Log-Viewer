const crypto = require('node:crypto');

// Simulates other extensions sharing the extension host: synchronous bursts on the
// event loop and continuous jobs on the shared libuv threadpool.
// ALV_LAB_NEIGHBOR="<busyMs>:<periodMs>:<poolJobs>", for example "400:500:8".
function parseConfig(raw) {
  const [busyMs, periodMs, poolJobs] = String(raw || '')
    .split(':')
    .map(value => Number.parseInt(value, 10));
  if (![busyMs, periodMs, poolJobs].every(Number.isFinite)) return undefined;
  return { busyMs, periodMs, poolJobs };
}

exports.activate = context => {
  const config = parseConfig(process.env.ALV_LAB_NEIGHBOR);
  if (!config) return;
  let stopped = false;
  const timer =
    config.busyMs > 0
      ? setInterval(() => {
          const end = Date.now() + config.busyMs;
          while (Date.now() < end) {}
        }, config.periodMs)
      : undefined;
  const pump = () => {
    if (!stopped) crypto.pbkdf2('neighbor', 'salt', 60_000, 64, 'sha512', pump);
  };
  for (let i = 0; i < config.poolJobs; i++) pump();
  context.subscriptions.push({
    dispose: () => {
      stopped = true;
      if (timer) clearInterval(timer);
    }
  });
};

exports.deactivate = () => {};
