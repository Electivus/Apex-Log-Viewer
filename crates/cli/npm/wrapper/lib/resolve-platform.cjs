const MAP = new Map([
  ['linux:x64', { packageName: '@electivus/apex-log-viewer-cli-linux-x64', binName: 'apex-log-viewer' }],
  ['linux:arm64', { packageName: '@electivus/apex-log-viewer-cli-linux-arm64', binName: 'apex-log-viewer' }],
  ['darwin:x64', { packageName: '@electivus/apex-log-viewer-cli-darwin-x64', binName: 'apex-log-viewer' }],
  ['darwin:arm64', { packageName: '@electivus/apex-log-viewer-cli-darwin-arm64', binName: 'apex-log-viewer' }],
  ['win32:x64', { packageName: '@electivus/apex-log-viewer-cli-win32-x64', binName: 'apex-log-viewer.exe' }],
  ['win32:arm64', { packageName: '@electivus/apex-log-viewer-cli-win32-arm64', binName: 'apex-log-viewer.exe' }]
]);

function resolvePlatform(platform, arch) {
  const key = `${platform}:${arch}`;
  const match = MAP.get(key);
  if (!match) {
    throw new Error(`Unsupported platform ${platform}/${arch}`);
  }
  return match;
}

module.exports = { resolvePlatform };
