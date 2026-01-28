import { execSync } from 'node:child_process';

const run = (command) => execSync(command, { stdio: 'inherit' });

try {
  run('yarn build');
  run('npx oclif manifest');
  run('npx oclif lock');
  // npm shrinkwrap fails inside workspace packages; skip it here.
} catch (error) {
  process.exitCode = error?.status ?? 1;
}
