import { build } from 'esbuild';

await build({
  entryPoints: ['apps/vscode-extension/src/extension.ts'],
  outfile: 'apps/vscode-extension/dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  alias: {
    bfj: './src/shims/bfj.ts'
  },
  external: ['vscode', '@vscode/ripgrep', 'tree-sitter-sfapex']
});
