import { execSync } from 'node:child_process';

try {
  execSync('sf-clean --ignore-signing-artifacts', { stdio: 'inherit' });
} catch (error) {
  // Cleanup should not fail the publish.
  console.warn('postpack cleanup failed; continuing.');
}
