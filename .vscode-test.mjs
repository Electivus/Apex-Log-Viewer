import { defineConfig } from '@vscode/test-cli';

// Allow opting-in to Marketplace installs via env to avoid hangs offline.
const shouldInstallDeps = /^1|true$/i.test(String(process.env.VSCODE_TEST_INSTALL_DEPS || ''));
const installExtensions = shouldInstallDeps ? ['salesforce.salesforcedx-vscode'] : [];

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
  mocha: {
    timeout: 30000,
    reporter: 'spec',
    require: './out/test/mocha.setup.js',
    grep: '^integration'
  }
});
