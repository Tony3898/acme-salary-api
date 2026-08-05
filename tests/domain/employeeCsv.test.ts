import { parseCsv } from '../../src/domain/csv';
import {
  EMPLOYEE_CSV_COLUMNS,
  parseEmployeeCsv,
  toProblemReportCsv,
} from '../../src/domain/employeeCsv';

/**
 * Row-by-row validation, with no database.
 *
 * The property under test throughout is that a bad file produces a *list* of
 * problems rather than the first one. A preview that reports one error at a time
 * means opening the file, fixing one cell and uploading again — nine thousand
 * times — and is worse than no preview.
 */

const REFERENCES = {
  departmentIdByName: new Map([
    ['engineering', 4],
    ['sales', 7],
  ]),
  jobLevelIdByName: new Map([
    ['senior', 3],
    ['junior', 1],
  ]),
};

const HEADER = EMPLOYEE_CSV_COLUMNS.join(',');

/** One valid row, which each test below then breaks in exactly one way. */
const VALID =
  'Ada Lovelace,ada@acme.test,GB,Engineering,Senior,Lead,2020-01-06,ACTIVE,,,85000.50,GBP,2020-01-06';

function parse(...lines: string[]) {
  return parseEmployeeCsv(parseCsv([HEADER, ...lines].join('\n')), REFERENCES);
}

describe('parseEmployeeCsv', () => {
  describe('a file that is right', () => {
    it('given one complete row, when parsed, then every field is read and there are no problems', () => {
      const result = parse(VALID);

      expect(result.problems).toEqual([]);
      expect(result.totalRows).toBe(1);
      expect(result.rows[0]).toEqual({
        row: 2,
        fullName: 'Ada Lovelace',
        email: 'ada@acme.test',
        country: 'GB',
        departmentId: 4,
        jobLevelId: 3,
        jobTitle: 'Lead',
        hireDate: '2020-01-06',
        status: 'ACTIVE',
        leftOn: null,
        managerEmail: null,
        pay: { amountMinor: 8_500_050, currency: 'GBP', effectiveFrom: '2020-01-06' },
      });
    });

    it('given no salary columns filled in, when parsed, then the row is valid with no pay', () => {
      const result = parse('Ada Lovelace,ada@acme.test,GB,Engineering,Senior,,2020-01-06,,,,,,');

      expect(result.problems).toEqual([]);
      expect(result.rows[0]?.pay).toBeNull();
      expect(result.rows[0]?.jobTitle).toBeNull();
    });

    it('given a blank status, when parsed, then the person is active', () => {
      expect(parse(VALID.replace(',ACTIVE,', ',,')).rows[0]?.status).toBe('ACTIVE');
    });

    it('given an address and a country in mixed case, when parsed, then they are normalised', () => {
      const result = parse(VALID.replace('ada@acme.test,GB', 'Ada@ACME.test,gb'));

      expect(result.rows[0]?.email).toBe('ada@acme.test');
      expect(result.rows[0]?.country).toBe('GB');
    });

    it('given headers written as a human would, when parsed, then they match the columns', () => {
      /* "Full Name" out of somebody else's HR system is the ordinary case, and
         refusing a file over a capital letter teaches people to fight the tool. */
      const header = 'Full Name,E-Mail,Country,Department,Job_Level,hire date';
      const result = parseEmployeeCsv(
        parseCsv(`${header}\nAda,ada@acme.test,GB,Engineering,Senior,2020-01-06`),
        REFERENCES,
      );

      expect(result.problems).toEqual([]);
      expect(result.rows).toHaveLength(1);
    });

    it('given an extra column the file keeps for itself, when parsed, then it is ignored', () => {
      const result = parseEmployeeCsv(
        parseCsv(`${HEADER},Notes\n${VALID},"chased twice"`),
        REFERENCES,
      );

      expect(result.problems).toEqual([]);
    });
  });

  describe('a file that is wrong', () => {
    it('given a row with three mistakes, when parsed, then all three are reported', () => {
      const result = parse('Ada,not-an-address,GBR,Marketing,Senior,,2020-01-06,,,,,,');

      expect(result.problems.map((problem) => problem.column)).toEqual([
        'email',
        'country',
        'department',
      ]);
      expect(result.rows).toEqual([]);
    });

    it('given problems on separate rows, when parsed, then each names its own line as a spreadsheet numbers it', () => {
      const result = parse(VALID, 'Grace,grace@acme.test,GB,Engineering,Nope,,2021-01-01,,,,,,');

      expect(result.problems).toHaveLength(1);
      // Header is line 1, so the second data row is line 3.
      expect(result.problems[0]?.row).toBe(3);
      expect(result.rows).toHaveLength(1);
    });

    it('given a missing required column, when parsed, then the header is reported once rather than every row', () => {
      const result = parseEmployeeCsv(
        parseCsv('fullName,email\nAda,ada@acme.test\nGrace,grace@acme.test'),
        REFERENCES,
      );

      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]?.column).toBe('header');
      expect(result.problems[0]?.message).toContain('country');
    });

    it('given an empty file, when parsed, then it says so', () => {
      expect(parseEmployeeCsv([], REFERENCES).problems[0]?.message).toBe('The file is empty.');
    });

    it('given the same address twice, when parsed, then the later row is reported and names the earlier line', () => {
      const result = parse(VALID, VALID);

      expect(result.rows).toHaveLength(1);
      expect(result.problems[0]?.row).toBe(3);
      expect(result.problems[0]?.message).toContain('line 2');
    });

    it('given somebody as their own manager, when parsed, then it is refused', () => {
      const result = parse(VALID.replace(',,85000.50', ',ada@acme.test,85000.50'));

      expect(result.problems[0]?.column).toBe('managerEmail');
    });

    it('given a very long field, when parsed, then the quoted value in the message is truncated', () => {
      /* Ten thousand rows each quoting a 5 KB field is a 50 MB error list, which is
         a way to turn a rejected import into a denial of service. */
      const result = parse(VALID.replace('GB,', `${'x'.repeat(5_000)},`));

      expect(result.problems[0]?.message.length).toBeLessThan(120);
    });
  });

  describe('the salary columns, which only mean anything together', () => {
    it('given an amount with no currency, when parsed, then the row is refused rather than assuming dollars', () => {
      /* Guessing a currency is a hundredfold error for anybody paid in rupees, and
         it would pass every later check. */
      const result = parse(VALID.replace(',85000.50,GBP,', ',85000.50,,'));

      expect(result.problems[0]?.column).toBe('salary');
      expect(result.problems[0]?.message).toContain('salaryCurrency');
    });

    it('given an amount with a thousands separator, when parsed, then it is refused rather than stripped', () => {
      /* "85,000.50" and "85000,50" mean the same amount in different places, and
         stripping the separator reads the second as eight and a half million. */
      const result = parse(VALID.replace('85000.50', '"85,000.50"'));

      expect(result.problems[0]?.column).toBe('salaryAmount');
    });

    it('given three decimal places, when parsed, then it is refused rather than rounded', () => {
      expect(parse(VALID.replace('85000.50', '85000.505')).problems[0]?.column).toBe(
        'salaryAmount',
      );
    });

    it('given an unsupported currency, when parsed, then it is named', () => {
      const result = parse(VALID.replace(',GBP,', ',JPY,'));

      expect(result.problems[0]?.column).toBe('salaryCurrency');
      expect(result.problems[0]?.message).toContain('JPY');
    });
  });

  describe('leaving dates, which the schema pairs with the status', () => {
    it('given a leaver with a date, when parsed, then both are read', () => {
      const result = parse(VALID.replace(',ACTIVE,,', ',LEFT,2025-06-30,'));

      expect(result.problems).toEqual([]);
      expect(result.rows[0]).toMatchObject({ status: 'LEFT', leftOn: '2025-06-30' });
    });

    it('given a leaver with no date, when parsed, then it is refused with the reason', () => {
      const result = parse(VALID.replace(',ACTIVE,,', ',LEFT,,'));

      expect(result.problems[0]?.column).toBe('leftOn');
    });

    it('given an active person with a leaving date, when parsed, then it is refused', () => {
      const result = parse(VALID.replace(',ACTIVE,,', ',ACTIVE,2025-06-30,'));

      expect(result.problems[0]?.column).toBe('leftOn');
    });

    it('given a leaving date before the hire date, when parsed, then it is refused', () => {
      const result = parse(VALID.replace(',ACTIVE,,', ',LEFT,2019-01-01,'));

      expect(result.problems[0]?.message).toContain('2020-01-06');
    });

    it('given a date that is the right shape but not a real day, when parsed, then it is refused', () => {
      const result = parse(VALID.replace('2020-01-06,ACTIVE', '2026-02-31,ACTIVE'));

      expect(result.problems[0]?.column).toBe('hireDate');
    });
  });
});

/**
 * The file back with a column saying what is wrong.
 *
 * Tested as its own thing because the numbering is the part that matters and the part
 * that is easy to get wrong: a report that puts row 4,812's complaint against row
 * 4,811 sends somebody to correct a row that was fine.
 */
describe('toProblemReportCsv', () => {
  const report = (...lines: string[]): string[][] => {
    const table = parseCsv([HEADER, ...lines].join('\n'));
    return parseCsv(toProblemReportCsv(table, parseEmployeeCsv(table, REFERENCES).problems));
  };

  it('given a file with one bad row, when reported, then the complaint is on that row', () => {
    const rows = report(VALID, VALID.replace('GB,', 'GBR,'), VALID.replace('ada@', 'grace@'));

    /* Three data rows and a header. The middle one is the broken one, and the two
       either side of it have an empty cell — which is the assertion, because an
       off-by-one would put text in one of those. */
    expect(rows).toHaveLength(4);
    expect(rows[1]?.at(-1)).toBe('');
    expect(rows[2]?.at(-1)).toContain('country');
    expect(rows[3]?.at(-1)).toBe('');
  });

  it('given a bad row, when reported, then the original columns are untouched', () => {
    /* The point of the whole format: somebody fixes the cell in this file and puts
       it back through the import. If the report rewrote or reordered anything, they
       would be correcting a copy that no longer matches their data. */
    const line = VALID.replace('GB,', 'GBR,');
    const rows = report(line);
    /* Compared against the line as it was sent, wrong value and all. The report is a
       copy of what somebody uploaded, not a corrected version of it. */
    const original = parseCsv(line)[0] ?? [];

    expect(rows[1]?.slice(0, original.length)).toEqual(original);
    expect(rows[0]?.slice(0, EMPLOYEE_CSV_COLUMNS.length)).toEqual([...EMPLOYEE_CSV_COLUMNS]);
  });

  it('given a row with several problems, when reported, then all of them are in the one cell', () => {
    const rows = report(VALID.replace('GB,Engineering', 'GBR,Marketing'));

    expect(rows[1]?.at(-1)).toContain('country');
    expect(rows[1]?.at(-1)).toContain('department');
  });

  it('given a header that could not be read, when reported, then the complaint is the whole report', () => {
    /* A missing column stops the parse before any row is read. Annotating the rows
       anyway would give every one of them an empty `problems` cell, which says they
       were checked and found fine — so the report is the complaint and nothing else. */
    const table = parseCsv(['fullName,email', 'Ada,ada@acme.test'].join('\n'));
    const rows = parseCsv(toProblemReportCsv(table, parseEmployeeCsv(table, REFERENCES).problems));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(['problems']);
    expect(rows[1]?.[0]).toContain('missing');
  });

  it('given the column it adds, when the report is read, then it is not an import column', () => {
    /* So a corrected file goes back through the import with the column still on it.
       An unknown column is ignored; a column named like a real one would be read as
       data. */
    const rows = report(VALID);
    const added = rows[0]?.at(-1) ?? '';

    expect(EMPLOYEE_CSV_COLUMNS).not.toContain(added);
  });
});
