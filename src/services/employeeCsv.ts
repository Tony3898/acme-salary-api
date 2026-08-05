import type { Database } from '../db/database';
import { accessScopeFor, type ScopeSubject } from '../domain/accessScope';
import { parseCsv, toCsvLine } from '../domain/csv';
import { toIsoDate } from '../domain/dates';
import {
  EMPLOYEE_CSV_COLUMNS,
  parseEmployeeCsv,
  toProblemReportCsv,
  type EmployeeCsvRow,
  type ImportProblem,
} from '../domain/employeeCsv';
import { orderByManager } from '../domain/importOrder';
import { formatMinorToDecimal } from '../domain/money';
import { AppError, HTTP_STATUS } from '../shared/errors';
import { logger } from '../shared/logger';
import {
  findEmployeeIdsByEmail,
  insertImportedEmployees,
  type ImportEmployee,
} from '../repositories/employeeImport';
import type { EmployeeListRow } from '../repositories/employeeRow';
import { listEmployees } from '../repositories/employees';
import type { LookupService } from './lookups';

/**
 * Getting a spreadsheet out, and getting one back in.
 *
 * These are one service because they are one contract: the columns the export
 * writes are the columns the import reads, and a file that comes out of here goes
 * back in. Splitting them would leave that agreement implicit in two files.
 */

/**
 * How many rows to read from the database at a time while exporting.
 *
 * The export ignores pagination — that is the point of it — but "no paging" and
 * "ten thousand rows in memory at once" are different things. Each chunk is
 * written out and dropped before the next is fetched, so the process holds a
 * thousand rows however large the company gets.
 */
const EXPORT_CHUNK = 1_000;

/**
 * The most rows one upload may contain.
 *
 * A limit on the parsed row count as well as on the request body, because 20 MB of
 * text is a different thing from 200,000 rows and only the second one has to be
 * validated, ordered and inserted inside a single transaction.
 */
const MAX_IMPORT_ROWS = 20_000;

/** How many problems to report. Enough to fix the file; not enough to be a payload. */
const MAX_REPORTED_PROBLEMS = 200;

export interface ExportRequest {
  search?: string;
  country?: string;
  departmentId?: number;
  jobLevelId?: number;
  status?: 'ACTIVE' | 'LEFT';
  /** Salaries as they stood on this date. Defaults to today. */
  asOf?: string;
}

export interface ImportRequest {
  /** The raw file, as text. */
  csv: string;
  /** Whether to write. False produces the same report and changes nothing. */
  apply: boolean;
  /** The account importing, from the verified token rather than the body. */
  importedByUserId: number;
}

export interface ImportReport {
  totalRows: number;
  /** Rows that passed every check. Equal to `created` after a successful apply. */
  validRows: number;
  /** Capped; `problemCount` says how many there really were. */
  problems: ImportProblem[];
  problemCount: number;
  /** Whether anything was written. False for a preview, and false for a refused apply. */
  applied: boolean;
  created: number;
}

export interface EmployeeCsvService {
  /** CSV lines, a chunk of rows at a time, so nothing holds the whole company. */
  exportRows: (subject: ScopeSubject, request: ExportRequest) => AsyncIterable<string>;
  importRows: (subject: ScopeSubject, request: ImportRequest) => Promise<ImportReport>;
  /**
   * The uploaded file back, with a `problems` column added.
   *
   * A separate operation rather than a flag on the import, because there is no such
   * thing as a report that also writes: a signature that cannot express the
   * combination is better than a line of code that ignores it. Both run the same
   * validation — `checkFile` below — so the file somebody works from and the figures
   * they were shown cannot disagree.
   *
   * Uncapped, unlike `ImportReport.problems`: that cap keeps a JSON response small,
   * and this *is* the thing somebody works from.
   */
  problemReportCsv: (subject: ScopeSubject, csv: string) => Promise<string>;
}

export interface EmployeeCsvServiceDeps {
  db: Database;
  now: () => Date;
  /** For resolving department and level names, which is what a spreadsheet has. */
  lookups: LookupService;
}

export function createEmployeeCsvService(deps: EmployeeCsvServiceDeps): EmployeeCsvService {
  return {
    exportRows(subject: ScopeSubject, request: ExportRequest): AsyncIterable<string> {
      return exportGenerator(deps, subject, request);
    },

    async importRows(subject: ScopeSubject, request: ImportRequest): Promise<ImportReport> {
      const checked = await checkFile(deps, subject, request.csv);
      const report = summarise(checked);

      if (!request.apply) {
        return report;
      }

      /**
       * A partial import is refused outright.
       *
       * The tempting alternative is to write the 9,842 good rows and report the
       * 158 bad ones. That leaves the company with 158 people missing and no
       * record of which, and the file cannot be corrected and re-uploaded because
       * the good rows would now collide. All of it or none of it is the only
       * version somebody can recover from.
       */
      if (checked.problems.length > 0 || report.validRows === 0) {
        return report;
      }

      const created = await insertImportedEmployees(
        deps.db,
        checked.layers.map((layer) => layer.map(toImportEmployee)),
        checked.existingIdByEmail,
        request.importedByUserId,
      );

      logger.info('employees.imported', {
        created,
        importedByUserId: request.importedByUserId,
        // No names, no addresses, no amounts. A log is the easiest place to read unnoticed.
      });

      return { ...report, applied: true, created };
    },

    async problemReportCsv(subject: ScopeSubject, csv: string): Promise<string> {
      const checked = await checkFile(deps, subject, csv);

      return toProblemReportCsv(checked.table, checked.problems);
    },
  };
}

/** Everything one pass over a file establishes, whatever the caller wants to do with it. */
interface CheckedFile {
  /** The rows as parsed, kept so a report can be written against the file as uploaded. */
  table: readonly (readonly string[])[];
  totalRows: number;
  /** Every problem, uncapped. Callers decide what to show. */
  problems: ImportProblem[];
  /** Rows to insert, managers before their reports. Empty when anything is wrong. */
  layers: EmployeeCsvRow[][];
  /** Addresses already in the database, which resolve the managers a file names. */
  existingIdByEmail: ReadonlyMap<string, number>;
}

/**
 * One pass over an uploaded file: parse it, validate every row, and work out the order
 * they could be created in.
 *
 * The single place either operation gets its facts from. Importing and reporting on a
 * file are the same question asked for different reasons, and a second implementation
 * of the question is how a file of corrections comes to disagree with the preview that
 * produced it.
 *
 * Writes nothing. The two database reads here are lookups — reference names, and which
 * addresses are taken.
 */
async function checkFile(
  deps: EmployeeCsvServiceDeps,
  subject: ScopeSubject,
  csv: string,
): Promise<CheckedFile> {
  /* The scope decides, as it does for every write. Only HR Admin reaches these
     routes, and HR Admin's scope is everybody — but the check is here rather than
     assumed, so a role added later cannot import its way around its own scope. */
  const scope = accessScopeFor(subject);
  if (scope.kind !== 'ALL') {
    throw new AppError(
      HTTP_STATUS.FORBIDDEN,
      'FORBIDDEN',
      'Importing employees is available to HR Admin only.',
    );
  }

  const table = parseCsv(csv);

  if (table.length - 1 > MAX_IMPORT_ROWS) {
    throw new AppError(
      HTTP_STATUS.BAD_REQUEST,
      'INVALID_REQUEST',
      `A file may contain at most ${MAX_IMPORT_ROWS.toLocaleString('en-GB')} rows. Split it and import the parts.`,
    );
  }

  const lookups = await deps.lookups.get();
  const parsed = parseEmployeeCsv(table, {
    departmentIdByName: byLowerName(lookups.departments),
    jobLevelIdByName: byLowerName(lookups.jobLevels),
  });

  /* Everything the file mentions: the people it would create, and the managers it
     points at. One query answers both "is this address taken" and "which id does this
     manager resolve to". */
  const managerEmails = parsed.rows
    .map((row) => row.managerEmail)
    .filter((email): email is string => email !== null);
  const existingIdByEmail = await findEmployeeIdsByEmail(deps.db, [
    ...new Set([...parsed.rows.map((row) => row.email), ...managerEmails]),
  ]);

  const problems = [...parsed.problems];

  /* Addresses already on somebody's record. Checked here rather than left to the
     unique index, because a constraint violation aborts the transaction and reports
     one collision, where the file may contain forty. */
  const available = parsed.rows.filter((row) => {
    if (!existingIdByEmail.has(row.email)) {
      return true;
    }
    problems.push({
      row: row.row,
      column: 'email',
      message: 'Somebody already has that email address.',
    });
    return false;
  });

  const order = orderByManager(available, new Set(existingIdByEmail.keys()));

  for (const row of order.missingManager) {
    problems.push({
      row: row.row,
      column: 'managerEmail',
      message: `No employee has the address ${String(row.managerEmail)}, and this file does not create one.`,
    });
  }
  for (const row of order.cyclic) {
    problems.push({
      row: row.row,
      column: 'managerEmail',
      message:
        'These people are listed as managing each other, so there is no order to create them in.',
    });
  }

  return {
    table,
    totalRows: parsed.totalRows,
    problems,
    layers: order.layers,
    existingIdByEmail,
  };
}

/** The JSON view of a checked file: the counts, and enough problems to act on. */
function summarise(checked: CheckedFile): ImportReport {
  return {
    totalRows: checked.totalRows,
    validRows: checked.layers.reduce((total, layer) => total + layer.length, 0),
    problems: checked.problems.slice(0, MAX_REPORTED_PROBLEMS),
    problemCount: checked.problems.length,
    applied: false,
    created: 0,
  };
}

/**
 * The export, one chunk at a time.
 *
 * A generator rather than a returned string: at ten thousand rows the file is a
 * couple of megabytes, and building it in memory to hand over in one piece means
 * the process holds all of it while the client reads it slowly over a phone
 * connection. The route writes each chunk as it arrives.
 */
async function* exportGenerator(
  deps: EmployeeCsvServiceDeps,
  subject: ScopeSubject,
  request: ExportRequest,
): AsyncGenerator<string> {
  const asOf = request.asOf ?? toIsoDate(deps.now());
  const scope = accessScopeFor(subject);

  yield toCsvLine(EMPLOYEE_CSV_COLUMNS);

  for (let page = 1; ; page += 1) {
    const { rows, total } = await listEmployees(deps.db, {
      scope,
      asOf,
      page,
      pageSize: EXPORT_CHUNK,
      /* Any sort would do, because the list query always ends its ORDER BY with
         id — which is exactly what a chunked walk needs. Without that tie-break a
         page boundary landing among people on identical salaries would write one
         of them twice and miss another, and the file would still look right. */
      sortBy: 'name',
      sortDir: 'asc',
      ...(request.search === undefined ? {} : { search: request.search }),
      ...(request.country === undefined ? {} : { country: request.country }),
      ...(request.departmentId === undefined ? {} : { departmentId: request.departmentId }),
      ...(request.jobLevelId === undefined ? {} : { jobLevelId: request.jobLevelId }),
      ...(request.status === undefined ? {} : { status: request.status }),
    });

    for (const row of rows) {
      yield toCsvLine(toCsvRecord(row));
    }

    if (page * EXPORT_CHUNK >= total || rows.length === 0) {
      return;
    }
  }
}

/** One employee as the column list describes them, in the same order. */
function toCsvRecord(employee: EmployeeListRow): string[] {
  return [
    employee.fullName,
    employee.email,
    employee.country,
    employee.departmentName,
    employee.jobLevelName,
    employee.jobTitle ?? '',
    employee.hireDate,
    employee.status,
    employee.leftOn ?? '',
    employee.managerEmail ?? '',
    /* A plain decimal with no separator and no symbol, which is exactly what the
       import will accept back. A formatted "$85,000.50" would split across two
       columns and be refused by the parser that wrote it. */
    employee.salary === null ? '' : formatMinorToDecimal(employee.salary.amountMinor),
    employee.salary?.currency ?? '',
    employee.salary?.effectiveFrom ?? '',
  ];
}

function toImportEmployee(row: {
  fullName: string;
  email: string;
  country: string;
  departmentId: number;
  jobLevelId: number;
  jobTitle: string | null;
  hireDate: string;
  status: 'ACTIVE' | 'LEFT';
  leftOn: string | null;
  managerEmail: string | null;
  pay: ImportEmployee['pay'];
}): ImportEmployee {
  return {
    employee: {
      fullName: row.fullName,
      email: row.email,
      country: row.country,
      departmentId: row.departmentId,
      jobLevelId: row.jobLevelId,
      jobTitle: row.jobTitle,
      hireDate: row.hireDate,
      status: row.status,
      leftOn: row.leftOn,
    },
    managerEmail: row.managerEmail,
    pay: row.pay,
  };
}

function byLowerName(items: readonly { id: number; name: string }[]): Map<string, number> {
  return new Map(items.map((item) => [item.name.trim().toLowerCase(), item.id]));
}
