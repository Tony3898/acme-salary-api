import { toCsvLine } from './csv';
import { isValidIsoDate } from './dates';
import { isSupportedCurrency, parseAmountToMinor, type Currency } from './money';

/**
 * The shape of an employee as a spreadsheet row.
 *
 * Export and import are written against this one column list, which makes a round
 * trip a real property rather than a hope: what comes out of the export can be
 * edited in Excel and put back through the import. That is the actual migration
 * path off spreadsheets, and it is also the cheapest test of both halves — a file
 * that exports and re-imports to the same figures cannot have a column mismatch.
 *
 * References are by **name and email**, never by id. A spreadsheet has "Engineering"
 * and "ada.lead@acme.test" in it; it does not have department 4 and employee 812,
 * and asking somebody to look those up is asking them to make mistakes.
 */

export const EMPLOYEE_CSV_COLUMNS = [
  'fullName',
  'email',
  'country',
  'department',
  'jobLevel',
  'jobTitle',
  'hireDate',
  'status',
  'leftOn',
  'managerEmail',
  'salaryAmount',
  'salaryCurrency',
  'salaryEffectiveFrom',
] as const;

export type EmployeeCsvColumn = (typeof EMPLOYEE_CSV_COLUMNS)[number];

/** Which columns a file cannot leave out. The rest may be blank. */
const REQUIRED_COLUMNS: readonly EmployeeCsvColumn[] = [
  'fullName',
  'email',
  'country',
  'department',
  'jobLevel',
  'hireDate',
];

/** The three salary columns only mean anything together. */
const PAY_COLUMNS: readonly EmployeeCsvColumn[] = [
  'salaryAmount',
  'salaryCurrency',
  'salaryEffectiveFrom',
];

const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;
const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const MAX_JOB_TITLE_LENGTH = 120;
/** Enough to look like an address without being a way to make a long error message. */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Something wrong with one field of one row, in the words of whoever has to fix it. */
export interface ImportProblem {
  /** The line number in the file as opened in a spreadsheet, header being line 1. */
  row: number;
  column: string;
  message: string;
}

/** A row that passed every check that does not need the database. */
export interface EmployeeCsvRow {
  row: number;
  fullName: string;
  email: string;
  country: string;
  departmentId: number;
  jobLevelId: number;
  jobTitle: string | null;
  hireDate: string;
  status: 'ACTIVE' | 'LEFT';
  leftOn: string | null;
  /** Lower-cased. Resolved to an id by the service, which can see the database. */
  managerEmail: string | null;
  pay: { amountMinor: number; currency: Currency; effectiveFrom: string } | null;
}

/** The names a file may refer to, from the lookup tables. */
export interface CsvReferences {
  /** Keyed by the department name, lower-cased and trimmed. */
  departmentIdByName: ReadonlyMap<string, number>;
  jobLevelIdByName: ReadonlyMap<string, number>;
}

export interface ParsedEmployeeCsv {
  rows: EmployeeCsvRow[];
  problems: ImportProblem[];
  /** Data rows read, valid or not. Excludes the header and blank lines. */
  totalRows: number;
}

/**
 * Every row checked, and every problem collected.
 *
 * Deliberately does not stop at the first failure. "Row 812: hireDate is not a
 * date" on its own means opening the file, fixing one cell, uploading again, and
 * finding row 813 — nine thousand times. A list of everything wrong is the whole
 * value of a preview.
 *
 * A row with any problem contributes no draft, so `rows.length + rowsWithProblems`
 * is the total and a caller cannot half-import somebody.
 */
export function parseEmployeeCsv(
  table: readonly (readonly string[])[],
  references: CsvReferences,
): ParsedEmployeeCsv {
  const [headerRow, ...dataRows] = table;

  if (headerRow === undefined) {
    return {
      rows: [],
      problems: [{ row: 1, column: 'file', message: 'The file is empty.' }],
      totalRows: 0,
    };
  }

  const header = readHeader(headerRow);
  if (header.missing.length > 0) {
    return {
      rows: [],
      problems: [
        {
          row: 1,
          column: 'header',
          message: `The file is missing these columns: ${header.missing.join(', ')}.`,
        },
      ],
      totalRows: 0,
    };
  }

  const rows: EmployeeCsvRow[] = [];
  const problems: ImportProblem[] = [];
  /** Addresses already claimed by an earlier row in this same file. */
  const seenEmails = new Map<string, number>();

  for (const [index, dataRow] of dataRows.entries()) {
    // Line 1 is the header, so the first data row is line 2 — the number Excel shows.
    const lineNumber = index + 2;
    const field = (column: EmployeeCsvColumn): string => dataRow[header.indexOf[column]] ?? '';

    const rowProblems: ImportProblem[] = [];
    const parsed = readRow(lineNumber, field, references, rowProblems);

    if (parsed !== null) {
      const duplicateOf = seenEmails.get(parsed.email);

      if (duplicateOf === undefined) {
        seenEmails.set(parsed.email, lineNumber);
        rows.push(parsed);
      } else {
        /* Reported against the later row, naming the earlier one. Both are
           equally "the duplicate", and the one somebody is looking at is the one
           they can compare with the line named. */
        rowProblems.push({
          row: lineNumber,
          column: 'email',
          message: `The same address is on line ${String(duplicateOf)}.`,
        });
      }
    }

    problems.push(...rowProblems);
  }

  return { rows, problems, totalRows: dataRows.length };
}

/**
 * One row, or null when something was wrong with it.
 *
 * Everything is checked before returning, so a row with three mistakes reports
 * three rather than making somebody find them one upload at a time.
 */
function readRow(
  row: number,
  field: (column: EmployeeCsvColumn) => string,
  references: CsvReferences,
  problems: ImportProblem[],
): EmployeeCsvRow | null {
  const problem = (column: EmployeeCsvColumn | 'salary', message: string): void => {
    problems.push({ row, column, message });
  };

  const fullName = field('fullName');
  if (fullName === '') {
    problem('fullName', 'A name is required.');
  } else if (fullName.length > MAX_NAME_LENGTH) {
    problem('fullName', `A name cannot be longer than ${String(MAX_NAME_LENGTH)} characters.`);
  }

  const email = field('email').toLowerCase();
  if (email === '') {
    problem('email', 'An email address is required.');
  } else if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    problem('email', `"${truncate(email)}" is not an email address.`);
  }

  const country = field('country').toUpperCase();
  if (!COUNTRY_PATTERN.test(country)) {
    problem('country', `"${truncate(country)}" is not a two-letter country code.`);
  }

  const departmentId = references.departmentIdByName.get(key(field('department')));
  if (departmentId === undefined) {
    problem('department', `There is no department called "${truncate(field('department'))}".`);
  }

  const jobLevelId = references.jobLevelIdByName.get(key(field('jobLevel')));
  if (jobLevelId === undefined) {
    problem('jobLevel', `There is no job level called "${truncate(field('jobLevel'))}".`);
  }

  const jobTitle = field('jobTitle');
  if (jobTitle.length > MAX_JOB_TITLE_LENGTH) {
    problem(
      'jobTitle',
      `A job title cannot be longer than ${String(MAX_JOB_TITLE_LENGTH)} characters.`,
    );
  }

  const hireDate = field('hireDate');
  if (!isValidIsoDate(hireDate)) {
    problem('hireDate', `"${truncate(hireDate)}" is not a date as YYYY-MM-DD.`);
  }

  const status = readStatus(field('status'), problem);
  const leftOn = readLeavingDate(field('leftOn'), status, hireDate, problem);
  const pay = readPay(field, problem);

  const managerEmail = field('managerEmail').toLowerCase();
  if (managerEmail !== '' && !EMAIL_PATTERN.test(managerEmail)) {
    problem('managerEmail', `"${truncate(managerEmail)}" is not an email address.`);
  } else if (managerEmail !== '' && managerEmail === email) {
    problem('managerEmail', 'Somebody cannot be their own manager.');
  }

  if (problems.length > 0 || departmentId === undefined || jobLevelId === undefined) {
    return null;
  }

  return {
    row,
    fullName,
    email,
    country,
    departmentId,
    jobLevelId,
    jobTitle: jobTitle === '' ? null : jobTitle,
    hireDate,
    status,
    leftOn,
    managerEmail: managerEmail === '' ? null : managerEmail,
    pay,
  };
}

function readStatus(
  value: string,
  problem: (column: EmployeeCsvColumn, message: string) => void,
): 'ACTIVE' | 'LEFT' {
  const status = value.toUpperCase();

  if (status === '' || status === 'ACTIVE') {
    return 'ACTIVE';
  }
  if (status === 'LEFT') {
    return 'LEFT';
  }

  problem('status', `"${truncate(value)}" is not a status. Use ACTIVE or LEFT, or leave it blank.`);
  return 'ACTIVE';
}

/** The same pairing rule the schema enforces, reported per row instead of per file. */
function readLeavingDate(
  value: string,
  status: 'ACTIVE' | 'LEFT',
  hireDate: string,
  problem: (column: EmployeeCsvColumn, message: string) => void,
): string | null {
  if (status === 'ACTIVE') {
    if (value !== '') {
      problem('leftOn', 'Somebody who is still employed has no leaving date.');
    }
    return null;
  }

  if (value === '') {
    problem('leftOn', 'A leaving date is required for somebody whose status is LEFT.');
    return null;
  }
  if (!isValidIsoDate(value)) {
    problem('leftOn', `"${truncate(value)}" is not a date as YYYY-MM-DD.`);
    return null;
  }
  if (isValidIsoDate(hireDate) && value < hireDate) {
    problem('leftOn', `A leaving date cannot come before the hire date of ${hireDate}.`);
    return null;
  }

  return value;
}

/**
 * The starting salary, if the row has one.
 *
 * All three columns or none. A row with an amount and no currency is not a row
 * with a default currency — it is a row somebody has not finished, and guessing
 * dollars for it would be a silent hundredfold error for anybody paid in rupees.
 */
function readPay(
  field: (column: EmployeeCsvColumn) => string,
  problem: (column: EmployeeCsvColumn | 'salary', message: string) => void,
): EmployeeCsvRow['pay'] {
  const present = PAY_COLUMNS.filter((column) => field(column) !== '');

  if (present.length === 0) {
    return null;
  }
  if (present.length < PAY_COLUMNS.length) {
    const missing = PAY_COLUMNS.filter((column) => field(column) === '');
    problem(
      'salary',
      `A salary needs all of ${PAY_COLUMNS.join(', ')}. Missing: ${missing.join(', ')}.`,
    );
    return null;
  }

  const currency = field('salaryCurrency').toUpperCase();
  if (!isSupportedCurrency(currency)) {
    problem('salaryCurrency', `${truncate(currency)} is not a supported currency.`);
    return null;
  }

  const effectiveFrom = field('salaryEffectiveFrom');
  if (!isValidIsoDate(effectiveFrom)) {
    problem('salaryEffectiveFrom', `"${truncate(effectiveFrom)}" is not a date as YYYY-MM-DD.`);
    return null;
  }

  try {
    /* No locale guessing. parseAmountToMinor refuses "85,000.50" rather than
       stripping the comma, because half of Europe writes 85000,50 for the same
       amount and stripping would read it as eight and a half million. The message
       it throws says what a valid amount looks like. */
    return { amountMinor: parseAmountToMinor(field('salaryAmount')), currency, effectiveFrom };
  } catch (error) {
    problem('salaryAmount', error instanceof Error ? error.message : 'That is not a valid amount.');
    return null;
  }
}

/**
 * Where each column is, and which are absent.
 *
 * Header names are matched loosely — case, spaces and underscores are ignored — so
 * "Full Name", "full_name" and "fullName" are the same column. That is not
 * leniency for its own sake: the file usually comes out of somebody else's system,
 * and refusing it over a capital letter teaches people to fight the tool. An
 * unrecognised column is ignored rather than refused, so a spreadsheet with a
 * "Notes" column somebody keeps for themselves still imports.
 */
function readHeader(headerRow: readonly string[]): {
  indexOf: Record<EmployeeCsvColumn, number>;
  missing: string[];
} {
  const positions = new Map<string, number>();

  for (const [index, name] of headerRow.entries()) {
    const normalised = key(name).replaceAll(/[\s_-]/g, '');
    // First occurrence wins, so a duplicated column cannot silently shadow the real one.
    if (!positions.has(normalised)) {
      positions.set(normalised, index);
    }
  }

  const indexOf = {} as Record<EmployeeCsvColumn, number>;
  const missing: string[] = [];

  for (const column of EMPLOYEE_CSV_COLUMNS) {
    const found = positions.get(column.toLowerCase());
    // -1 makes the field lookup return '', which the required-column checks catch.
    indexOf[column] = found ?? -1;

    if (found === undefined && REQUIRED_COLUMNS.includes(column)) {
      missing.push(column);
    }
  }

  return { indexOf, missing };
}

function key(value: string): string {
  return value.trim().toLowerCase();
}

/** The column the report adds. Not one of the import columns, so a corrected file re-imports as it is. */
const PROBLEM_COLUMN = 'problems';

/**
 * The file back, with a column saying what is wrong with each row.
 *
 * The alternative — a list of problems — is what the preview screen already shows,
 * and it stops being usable at about thirty. Somebody with 158 bad rows in a
 * spreadsheet of ten thousand cannot work from a list: they have to find row 4,812,
 * read what was wrong with it, fix the cell, and do it again 157 times, with the list
 * in another window and no way to mark their place.
 *
 * So the report is the original file, unchanged, with one column added. It opens in
 * Excel with the complaint next to the data it is about, sorts and filters like any
 * other column, and — because `problems` is not an import column — the corrected file
 * goes straight back through the import with the column still on it.
 *
 * Every row is included, not only the bad ones. A file of just the failures cannot be
 * re-imported: it is missing the 9,842 rows that were fine, and the ones it has would
 * have to be merged back by hand, which is the error-prone step this is replacing.
 */
export function toProblemReportCsv(
  table: readonly (readonly string[])[],
  problems: readonly ImportProblem[],
): string {
  const byRow = new Map<number, string[]>();
  for (const problem of problems) {
    const text = `${problem.column}: ${problem.message}`;
    const existing = byRow.get(problem.row);

    if (existing === undefined) {
      byRow.set(problem.row, [text]);
    } else {
      existing.push(text);
    }
  }

  const header = table[0];
  /* Anything that is not about a row: an empty file, or a header missing a column.
     Row 1 is the header, so a problem numbered 1 — or one numbered past the end — is
     about the file rather than about a person. */
  const fileProblems = [...byRow.entries()]
    .filter(([row]) => row < 2 || row > table.length)
    .flatMap(([, texts]) => texts);

  /**
   * A file whose header could not be read gets the complaint and nothing else.
   *
   * Not a fallback header and a column of blanks: when the header is wrong, *no row was
   * validated*, and annotating ten thousand rows with an empty `problems` cell would say
   * they were all fine. The fix is to the header of their own file, which they still
   * have. Two lines is the honest length of this answer.
   */
  if (header === undefined || fileProblems.length > 0) {
    return toCsvLine([PROBLEM_COLUMN]) + toCsvLine([fileProblems.join('; ')]);
  }

  const lines = [toCsvLine([...header, PROBLEM_COLUMN])];

  for (const [index, row] of table.slice(1).entries()) {
    /* Row 1 is the header, so the first data row is row 2 — the same numbering the
       problems use and the same one a spreadsheet shows down its left edge. Getting
       this off by one would put every complaint against the wrong person. */
    lines.push(toCsvLine([...row, (byRow.get(index + 2) ?? []).join('; ')]));
  }

  return lines.join('');
}

/**
 * Keeps a quoted value short enough that a bad row cannot make the response large.
 * Ten thousand rows each quoting a 5 KB field is a 50 MB error list.
 */
function truncate(value: string): string {
  const limit = 40;
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
