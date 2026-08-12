const path = require('node:path');

function normalizeChangedPath(value) {
  return String(value || '')
    .trim()
    .replaceAll('\\', '/');
}

function isDocumentationOnlyPath(value) {
  const changedPath = normalizeChangedPath(value);
  if (!changedPath) return false;
  const basename = path.posix.basename(changedPath).toLowerCase();
  return (
    changedPath.startsWith('docs/') ||
    changedPath.startsWith('.github/ISSUE_TEMPLATE/') ||
    changedPath === '.github/PULL_REQUEST_TEMPLATE.md' ||
    basename.endsWith('.md') ||
    basename === 'license'
  );
}

function shouldRunRealOrgE2E(changedPaths) {
  return changedPaths.length === 0 || changedPaths.some(changedPath => !isDocumentationOnlyPath(changedPath));
}

if (require.main === module) {
  process.stdout.write(`${shouldRunRealOrgE2E(process.argv.slice(2))}\n`);
}

module.exports = { isDocumentationOnlyPath, shouldRunRealOrgE2E };
