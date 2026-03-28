import { build } from 'esbuild';

await build({
  entryPoints: ['apps/vscode-extension/src/extension.ts'],
  outfile: 'apps/vscode-extension/dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode', 'tree-sitter-sfapex']
});
