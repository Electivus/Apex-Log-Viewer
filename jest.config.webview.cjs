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
  roots: ['<rootDir>/src/webview/__tests__'],
  testMatch: ['**/*.test.{ts,tsx}'],
  setupFilesAfterEnv: ['<rootDir>/src/webview/__tests__/setupTests.ts'],
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
    '<rootDir>/src/webview/components/**/*.{ts,tsx}',
    '<rootDir>/src/webview/lib/**/*.{ts,tsx}',
    '!<rootDir>/src/webview/**/__tests__/**/*',
    '!<rootDir>/src/webview/components/tail/TailList.tsx',
    '!<rootDir>/src/webview/components/FilterSelect.tsx'
  ],
  coverageThreshold: {
    'src/webview/components/**/*.{ts,tsx}': {
      statements: 70,
      branches: 50,
      functions: 70,
      lines: 70
    }
  },
  moduleNameMapper: {
    '\\.(css|less|scss|sass)$': '<rootDir>/src/webview/__tests__/styleMock.js'
  }
};
