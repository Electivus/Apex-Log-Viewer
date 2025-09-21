/** @type {import('jest').Config} */
module.exports = {
  displayName: 'webview',
  clearMocks: true,
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src/webview/__tests__'],
  testMatch: ['**/*.test.(ts|tsx)'],
  setupFilesAfterEnv: ['<rootDir>/src/webview/__tests__/setupTests.ts'],
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.webview-tests.json',
        isolatedModules: true
      }
    ]
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  collectCoverage: true,
  coverageDirectory: '<rootDir>/coverage/webview',
  collectCoverageFrom: [
    '<rootDir>/src/webview/**/*.{ts,tsx}',
    '!<rootDir>/src/webview/**/__tests__/**/*'
  ],
  coverageThreshold: {
    global: {
      statements: 90,
      branches: 80,
      functions: 90,
      lines: 90
    }
  },
  moduleNameMapper: {
    '\\.(css|less|scss|sass)$': '<rootDir>/src/webview/__tests__/styleMock.js'
  }
};
