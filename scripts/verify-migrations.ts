import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Whether the committed migrations still describe the schema in `schema.ts`.
 *
 * The failure this exists to catch is quiet and specific. `drizzle-kit push` applies
 * a schema change straight to a database without writing a migration, which is
 * convenient while building and dangerous the moment anybody else has a database:
 * their copy stays on the old shape, the tests pass on both, and the difference only
 * appears when the change reaches an environment that cannot be rebuilt from a seed
 * script. Nothing in a review shows it either — the diff shows a changed column and
 * no migration, which looks like a change that needed none.
 *
 * The check is a generate into a *copy* of the migrations folder. Drizzle compares the
 * schema against the snapshot it keeps there; if they agree it writes nothing, and if
 * they do not it writes the SQL for the difference — which is exactly the missing
 * migration, and gets printed so the fix is a paste rather than an investigation.
 * Nothing is written to the real folder, so the check never changes what it checks.
 *
 * **No database.** The snapshot in `meta/` is the reference, not a live server, so
 * this runs in CI before anything is provisioned and cannot be fooled by a database
 * somebody has already pushed to by hand.
 */

const MIGRATIONS_DIR = 'src/db/migrations';

/**
 * Relative, and inside the repository. Two reasons, both learned the hard way:
 * drizzle-kit resolves `--out` by prefixing `./`, so an absolute path becomes
 * `.//var/folders/…` and the run fails; and it fails by printing an error and
 * exiting 0, which a check that only looked for new files would report as a pass.
 * Hence both the relative path and the sentinel below.
 */
const SCRATCH_DIR = join('tmp', 'migration-drift');

/** What drizzle-kit prints when the schema and the snapshot already agree. */
const NO_CHANGES = 'No schema changes';

function sqlFilesIn(directory: string): string[] {
  return readdirSync(directory)
    .filter((entry) => entry.endsWith('.sql'))
    .sort();
}

function main(): void {
  const committed = sqlFilesIn(MIGRATIONS_DIR);

  rmSync(SCRATCH_DIR, { recursive: true, force: true });
  mkdirSync(SCRATCH_DIR, { recursive: true });

  try {
    cpSync(MIGRATIONS_DIR, SCRATCH_DIR, { recursive: true });

    /* The local binary rather than npx, and flags rather than drizzle.config.ts:
       the config reads DATABASE_URL through the validated config, and this check
       must not need a database at all. */
    const output = execFileSync(
      join('node_modules', '.bin', 'drizzle-kit'),
      [
        'generate',
        '--dialect',
        'postgresql',
        '--schema',
        './src/db/schema.ts',
        '--out',
        SCRATCH_DIR,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const added = sqlFilesIn(SCRATCH_DIR).filter((file) => !committed.includes(file));

    if (added.length > 0) {
      console.error(
        `FAIL  schema.ts has changes with no migration  [${added.length.toString()} missing]`,
      );
      for (const file of added) {
        console.error(`\n--- what is missing (${file}) ---`);
        console.error(readFileSync(join(SCRATCH_DIR, file), 'utf8').trim());
      }
      console.error('\nRun: npm run db:generate -- --name <what_changed>');
      process.exitCode = 1;
      return;
    }

    /* Nothing added is only good news if the tool got far enough to say so. Without
       this, a drizzle-kit that failed for any reason at all reports a clean schema. */
    if (!output.includes(NO_CHANGES)) {
      console.error('FAIL  drizzle-kit did not report on the schema, so nothing was verified');
      console.error(output.trim());
      process.exitCode = 1;
      return;
    }

    console.log(
      `PASS  ${MIGRATIONS_DIR} matches schema.ts  [${committed.length.toString()} migration(s)]`,
    );
  } finally {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error: unknown) {
  console.error('Verification failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
