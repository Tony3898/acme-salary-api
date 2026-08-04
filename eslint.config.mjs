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
    linterOptions: {
      /* A rule that can be switched off in a comment is a rule that gets switched
         off in the file where it mattered. If one of these is genuinely wrong, it
         is wrong here, in the config, where the exception is visible. */
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error',
    },
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
    /* Architectural boundary: only repositories talk to the database.
       container.ts is exempt because it *builds* the connection and hands it to
       the repositories — the one place that is allowed to, and it runs no
       queries of its own. */
    files: ['src/**/*.ts'],
    ignores: ['src/repositories/**', 'src/db/**', 'src/container.ts'],
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
