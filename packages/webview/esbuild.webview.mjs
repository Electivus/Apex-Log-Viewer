import { build, context } from 'esbuild';

const entryPoints = [
  'packages/webview/src/main.tsx',
  'packages/webview/src/tail.tsx',
  'packages/webview/src/logViewer.tsx',
  'packages/webview/src/debugFlags.tsx'
];

const isWatch = process.argv.includes('--watch');
const isMinify = process.argv.includes('--minify');

const options = {
  entryPoints,
  outdir: 'apps/vscode-extension/media',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  sourcemap: isWatch,
  minify: isMinify,
  logLevel: 'info'
};

if (isWatch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
