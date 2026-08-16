import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';

export default tseslint.config(
  {
    ignores: [
      '.angular/**',
      'coverage/**',
      'dist/**',
      'node_modules/**',
      'out/**',
      'test-results/**',
    ],
  },
  {
    files: ['forge.config.js'],
    ...eslint.configs.recommended,
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['src/**/*.ts', 'electron/**/*.ts', 'shared/**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      ...angular.configs.tsRecommended,
      eslintConfigPrettier,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['src/**/*.ts', 'electron/**/*.ts', 'shared/**/*.ts'],
    ignores: ['src/app/core/simulation/v1-reference/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['v1-reference', 'v1-reference/**', '**/v1-reference', '**/v1-reference/**'],
              message:
                'The v1 simulator is a test oracle only; production and unrelated tests must not import it.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.html'],
    extends: [
      ...angular.configs.templateRecommended,
      ...angular.configs.templateAccessibility,
      eslintConfigPrettier,
    ],
  },
);
