import { build, context } from 'esbuild';

const args = new Set(process.argv.slice(2));
const watchMode = args.has('--watch');
const minify = args.has('--minify');

const buildOptions = {
  entryPoints: ['apps/vscode-extension/src/extension.ts'],
  outfile: 'apps/vscode-extension/dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  minify,
  external: ['vscode', 'tree-sitter-sfapex'],
  plugins: watchMode
    ? [
        {
          name: 'vscode-task-watch-status',
          setup(build) {
            build.onStart(() => {
              console.log('[watch] build started');
            });

            build.onEnd(result => {
              if (result.errors.length > 0) {
                return;
              }
              console.log('[watch] build finished, watching for changes...');
            });
          }
        }
      ]
    : []
};

if (watchMode) {
  const watcher = await context(buildOptions);
  await watcher.watch();
  await new Promise(() => {});
} else {
  await build(buildOptions);
}
