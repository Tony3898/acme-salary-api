import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'src/db/migrations/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // The config files themselves sit outside tsconfig's include.
        projectService: { allowDefaultProject: ['*.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'Money is stored in whole minor units. See src/domain/money.ts.',
        },
      ],
    },
  },
  {
    // Architectural boundary: only repositories talk to the database.
    files: ['src/**/*.ts'],
    ignores: ['src/repositories/**', 'src/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'drizzle-orm',
              message: 'Database access belongs in src/repositories/.',
            },
          ],
          patterns: [
            {
              group: ['drizzle-orm/*', '**/db/client'],
              message: 'Database access belongs in src/repositories/.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: { 'no-restricted-imports': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
