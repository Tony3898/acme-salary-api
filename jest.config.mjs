/**
 * Tests run through @swc/jest, which strips types without checking them.
 * Type errors are caught by `npm run typecheck`, not by a green test run.
 */
/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: {
          target: 'es2022',
          parser: { syntax: 'typescript' },
        },
      },
    ],
  },
  clearMocks: true,
  restoreMocks: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/db/seed.ts', '!src/server.ts'],
  coverageThreshold: {
    global: { statements: 80, branches: 80, functions: 80, lines: 80 },
  },
  // PGlite boots a WebAssembly Postgres per test file; the default 5s is tight.
  testTimeout: 20_000,
};
