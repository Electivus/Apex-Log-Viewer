import { defineConfig } from '@vscode/test-cli';

// Run tests with a clean profile and only the
// Salesforce extension installed (no other extensions).
export default defineConfig({
  // Use Insiders to avoid conflict with a running stable VS Code
  version: 'insiders',
  files: 'out/test/**/*.test.js',
  // Prevent implicit installs via package.json `extensionDependencies`.
  skipExtensionDependencies: true,
  // Explicitly install only our prerequisite extension.
  installExtensions: ['salesforce.salesforcedx-vscode'],
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
