import { defineConfig } from '@vscode/test-cli';

// Allow opting-in to Marketplace installs via env to avoid hangs offline.
const shouldInstallDeps = /^1|true$/i.test(String(process.env.VSCODE_TEST_INSTALL_DEPS || ''));
const installExtensions = shouldInstallDeps ? ['salesforce.salesforcedx-vscode'] : [];

// Test scope control:
// - VSCODE_TEST_SCOPE=unit|integration|all (default: all)
// - Or fine-grained override via VSCODE_TEST_GREP and VSCODE_TEST_INVERT
const scope = String(process.env.VSCODE_TEST_SCOPE || 'all');
let grep;
let invert = false;

if (process.env.VSCODE_TEST_GREP) {
  grep = String(process.env.VSCODE_TEST_GREP);
  invert = /^1|true$/i.test(String(process.env.VSCODE_TEST_INVERT || ''));
} else {
  if (scope === 'integration') {
    grep = '^integration';
  } else if (scope === 'unit') {
    grep = '^integration';
    invert = true; // run everything except integration
  } else {
    grep = undefined; // run all
  }
}

// Build mocha options dynamically to avoid setting undefined fields.
const mocha = {
  timeout: 30000,
  reporter: 'spec',
  require: './out/test/mocha.setup.js',
  forbidOnly: true,
  ...(grep ? { grep } : {}),
  ...(invert ? { invert } : {})
};

// Run tests with a clean profile. Only install Salesforce extension when opted-in.
export default defineConfig({
  // Use Insiders to avoid conflict with a running stable VS Code
  version: 'insiders',
  files: 'out/test/**/*.test.js',
  // Prevent implicit installs via package.json `extensionDependencies`.
  skipExtensionDependencies: true,
  // Explicitly install only our prerequisite extension when requested.
  installExtensions,
  // Open tests with a sample workspace so activation
  // can read sfdx-project.json and set API version.
  workspaceFolder: process.env.VSCODE_TEST_WORKSPACE || './sample-workspace',
  mocha
});
