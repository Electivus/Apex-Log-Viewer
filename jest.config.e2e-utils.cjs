/** @type {import('jest').Config} */
module.exports = {
  displayName: 'e2e-utils',
  clearMocks: true,
  testEnvironment: 'node',
  roots: ['<rootDir>/test/e2e/utils/__tests__'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.e2e-utils-tests.json'
      }
    ]
  },
  moduleFileExtensions: ['ts', 'js', 'json']
};
