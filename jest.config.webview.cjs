/** @type {import('jest').Config} */
const wantCoverage =
  /^1|true$/i.test(String(process.env.JEST_COVERAGE || '')) ||
  /^1|true$/i.test(String(process.env.ENABLE_COVERAGE || '')) ||
  /^1|true$/i.test(String(process.env.CI || ''));

module.exports = {
  displayName: 'webview',
  clearMocks: true,
  testTimeout: 15000,
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/packages/webview/src'],
  testMatch: ['**/*.test.{ts,tsx}'],
  setupFilesAfterEnv: ['<rootDir>/packages/webview/src/__tests__/setupTests.ts'],
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.webview-tests.json'
      }
    ]
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  collectCoverage: wantCoverage,
  coverageDirectory: '<rootDir>/coverage/webview',
  collectCoverageFrom: [
    '<rootDir>/packages/webview/src/components/**/*.{ts,tsx}',
    '<rootDir>/packages/webview/src/lib/**/*.{ts,tsx}',
    '!<rootDir>/packages/webview/src/**/__tests__/**/*',
    '!<rootDir>/packages/webview/src/components/tail/TailList.tsx',
    '!<rootDir>/packages/webview/src/components/FilterSelect.tsx'
  ],
  coverageThreshold: {
    'packages/webview/src/components/**/*.{ts,tsx}': {
      statements: 70,
      branches: 50,
      functions: 70,
      lines: 70
    }
  },
  moduleNameMapper: {
    '\\.(css|less|scss|sass)$': '<rootDir>/packages/webview/src/__tests__/styleMock.js'
  }
};
