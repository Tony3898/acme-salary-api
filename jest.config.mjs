/**
 * Tests run through @swc/jest, which strips types without checking them.
 * Type errors are caught by `npm run typecheck`, not by a green test run.
 */
/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  /* Every test lives under tests/, mirroring src/. One place to look, and src/
     then contains only code that ships — which is what tsconfig.build.json
     compiles. */
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // After the environment exists, so it can install jest spies.
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
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
  /* Excluded: wiring with no logic of its own, covered by the app actually
     connecting rather than by a test asserting that a constructor was called. */
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/db/client.ts',
    '!src/db/seed/cli.ts',
    '!src/server.ts',
  ],
  coverageThreshold: {
    global: { statements: 80, branches: 80, functions: 80, lines: 80 },
  },
  // PGlite boots a WebAssembly Postgres per test file; the default 5s is tight.
  testTimeout: 20_000,
};
