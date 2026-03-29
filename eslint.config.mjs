import path from 'node:path';
import { fileURLToPath } from 'node:url';

import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import eslintConfigPrettier from 'eslint-config-prettier';

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));
const typeAwareProjects = [
  './tsconfig.extension.json',
  './tsconfig.test.json',
  './tsconfig.webview-tests.json'
];

export default [
  {
    ignores: ['apps/vscode-extension/src/test/fixtures/eslintTypeAware.fixture.ts']
  },
  {
    files: ['**/*.ts', '**/*.tsx']
  },
  {
    plugins: {
      '@typescript-eslint': typescriptEslint
    },
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: typeAwareProjects,
        tsconfigRootDir
      }
    },
    rules: {
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'import',
          format: ['camelCase', 'PascalCase']
        }
      ],
      curly: 'warn',
      eqeqeq: 'warn',
      'no-throw-literal': 'warn'
    }
  },
  // Disable rules that conflict with Prettier formatting
  eslintConfigPrettier
];
