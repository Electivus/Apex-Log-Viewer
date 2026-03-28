import { build } from 'esbuild';

await build({
  entryPoints: [
    'packages/webview/src/main.tsx',
    'packages/webview/src/tail.tsx',
    'packages/webview/src/logViewer.tsx',
    'packages/webview/src/debugFlags.tsx'
  ],
  outdir: 'apps/vscode-extension/media',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  sourcemap: true
});
