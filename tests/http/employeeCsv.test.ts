import request from 'supertest';
import { parseCsv } from '../../src/domain/csv';
import { EMPLOYEE_CSV_COLUMNS } from '../../src/domain/employeeCsv';
import { bodyOf } from '../helpers/http';
import { seedOrg, type SeededOrg } from '../helpers/org';
import { createTestHarness, type TestHarness } from '../helpers/testApp';
import { signInEveryone, type Signins } from '../helpers/tokens';

/**
 * The spreadsheet out and the spreadsheet back in.
 *
 * The round trip is the test that matters: export the company, put the same file
 * through the importer, and the columns have to line up. It is also the cheapest
 * possible check on both halves — a mismatch anywhere in thirteen columns shows up
 * as a validation problem rather than as data quietly landing in the wrong field.
 */

interface ImportReport {
  totalRows: number;
  validRows: number;
  problems: { row: number; column: string; message: string }[];
  problemCount: number;
  applied: boolean;
  created: number;
}

const HEADER = EMPLOYEE_CSV_COLUMNS.join(',');

describe('employee CSV', () => {
  let harness: TestHarness;
  let org: SeededOrg;
  let signins: Signins;

  const reportOf = (response: request.Response): ImportReport =>
    bodyOf(response) as unknown as ImportReport;

  beforeAll(async () => {
    harness = await createTestHarness();
    const managerEmployeeId = harness.accounts.manager.employeeId;
    if (managerEmployeeId === null) {
      throw new Error('The manager account must be linked to an employee.');
    }
    org = await seedOrg(harness.db, managerEmployeeId);
    signins = await signInEveryone(harness);
  });

  afterAll(async () => {
    await harness.close();
  });

  const exportAs = (email: Parameters<Signins['as']>[0], query = '') =>
    request(harness.app)
      .get(`/api/employees/export${query}`)
      .set('Authorization', signins.as(email));

  const importAs = (email: Parameters<Signins['as']>[0], csv: string, apply = false) =>
    request(harness.app)
      .post(`/api/employees/import?apply=${String(apply)}`)
      .set('Authorization', signins.as(email))
      .set('Content-Type', 'text/csv')
      .send(csv);

  describe('GET /api/employees/export', () => {
    it('given HR Admin, when they export, then every row they can see is in the file', async () => {
      const response = await exportAs('hr.admin@acme.test');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      // Header plus everybody. Paging is ignored, which is the point of an export.
      expect(parseCsv(response.text)).toHaveLength(org.totalEmployees + 1);
    });

    it('given an export, when read, then the columns are the ones the importer accepts', async () => {
      const response = await exportAs('hr.admin@acme.test');

      expect(parseCsv(response.text)[0]).toEqual([...EMPLOYEE_CSV_COLUMNS]);
    });

    it('given an export, when sent, then it is offered as a download and never cached', async () => {
      const response = await exportAs('hr.admin@acme.test');

      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('given a name containing a comma, when exported, then the row keeps its column count', async () => {
      /* The whole reason for a real writer rather than values.join(','). One name
         with a comma in it shifts every later field by one, and a hire date lands in
         the salary column. */
      await request(harness.app)
        .post('/api/employees')
        .set('Authorization', signins.as('hr.admin@acme.test'))
        .send({
          fullName: 'Smith, Jr.',
          email: 'comma.person@acme.test',
          country: 'US',
          departmentId: org.salesId,
          jobLevelId: org.juniorLevelId,
          hireDate: '2026-01-01',
        });

      const rows = parseCsv((await exportAs('hr.admin@acme.test')).text);
      const person = rows.find((row) => row[0] === 'Smith, Jr.');

      expect(person).toBeDefined();
      expect(person).toHaveLength(EMPLOYEE_CSV_COLUMNS.length);
    });

    it('given a salary, when exported, then the amount is a plain decimal the importer will accept back', async () => {
      const rows = parseCsv((await exportAs('hr.admin@acme.test')).text);
      const deepest = rows.find((row) => row[1] === 'deepest@acme.test');

      // 500,000,000 paise, written as digits with a full stop and nothing else.
      expect(deepest?.[10]).toBe('5000000.00');
      expect(deepest?.[11]).toBe('INR');
    });

    it('given a Manager, when they export, then the file holds their team and nobody else', async () => {
      const rows = parseCsv((await exportAs('manager@acme.test')).text);
      const addresses = rows.slice(1).map((row) => row[1]);

      expect(addresses).toContain('deepest@acme.test');
      expect(addresses).not.toContain('outside.lead@acme.test');
    });

    it('given an Employee, when they export, then the file holds one person', async () => {
      const rows = parseCsv((await exportAs('employee@acme.test')).text);

      expect(rows).toHaveLength(2);
    });

    it('given a filter, when exported, then the same filter applies as on the list', async () => {
      const rows = parseCsv(
        (await exportAs('hr.admin@acme.test', `?departmentId=${String(org.engineeringId)}`)).text,
      );

      expect(rows.slice(1).every((row) => row[3] === 'Engineering')).toBe(true);
    });

    it('given no token, when an export is asked for, then it is refused', async () => {
      const response = await request(harness.app).get('/api/employees/export');

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/employees/import', () => {
    it('given HR Viewer, when they import, then it is refused', async () => {
      const response = await importAs('hr.viewer@acme.test', `${HEADER}\n`);

      expect(response.status).toBe(403);
    });

    it('given a preview, when it finds nothing wrong, then it reports what would happen and writes nothing', async () => {
      const before = await countEmployees();
      const csv = `${HEADER}\nNew Person,preview@acme.test,US,Sales,Junior,,2026-02-01,,,,,,`;

      const report = reportOf(await importAs('hr.admin@acme.test', csv));

      expect(report).toMatchObject({ totalRows: 1, validRows: 1, applied: false, created: 0 });
      expect(await countEmployees()).toBe(before);
    });

    it('given a file with problems, when previewed, then the count and the specifics both come back', async () => {
      const csv = [
        HEADER,
        'Fine Person,fine@acme.test,US,Sales,Junior,,2026-02-01,,,,,,',
        'Bad Country,bad1@acme.test,USA,Sales,Junior,,2026-02-01,,,,,,',
        'Bad Level,bad2@acme.test,US,Sales,Nope,,2026-02-01,,,,,,',
      ].join('\n');

      const report = reportOf(await importAs('hr.admin@acme.test', csv));

      expect(report.totalRows).toBe(3);
      expect(report.validRows).toBe(1);
      expect(report.problemCount).toBe(2);
      expect(report.problems.map((problem) => problem.row)).toEqual([3, 4]);
    });

    it('given an address already on somebody, when previewed, then it is reported against that row', async () => {
      const csv = `${HEADER}\nClash,deep@acme.test,US,Sales,Junior,,2026-02-01,,,,,,`;

      const report = reportOf(await importAs('hr.admin@acme.test', csv));

      expect(report.validRows).toBe(0);
      expect(report.problems[0]?.message).toContain('already has that email');
    });

    describe('the problem report', () => {
      const badFile = [
        HEADER,
        'Fine Person,report.fine@acme.test,US,Sales,Junior,,2026-02-01,,,,,,',
        'Bad Country,report.bad@acme.test,USA,Sales,Junior,,2026-02-01,,,,,,',
      ].join('\n');

      const reportCsvAs = (csv: string, apply = false) =>
        request(harness.app)
          .post(`/api/employees/import?report=csv&apply=${String(apply)}`)
          .set('Authorization', signins.as('hr.admin@acme.test'))
          .set('Content-Type', 'text/csv')
          .send(csv);

      it('given a file with problems, when the report is asked for, then it comes back as a file', async () => {
        const response = await reportCsvAs(badFile);

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('text/csv');
        expect(response.headers['content-disposition']).toContain('attachment');
        // Individual salaries in a file: nothing in between may keep a copy.
        expect(response.headers['cache-control']).toBe('no-store');
      });

      it('given the report, when it is read, then every row is there and the problem is on the right one', async () => {
        const rows = parseCsv((await reportCsvAs(badFile)).text);

        /* Both data rows, not just the failing one — the file has to be correctable
           and re-importable as it stands. */
        expect(rows).toHaveLength(3);
        expect(rows[1]?.at(-1)).toBe('');
        expect(rows[2]?.at(-1)).toContain('country');
      });

      it('given the report and apply together, when sent, then nothing is written', async () => {
        /* Both flags at once is a client mistake rather than a request to be honoured.
           Asking what is wrong with a file cannot be the thing that imports it. */
        const before = await countEmployees();
        const csv = `${HEADER}\nReport Only,report.only@acme.test,US,Sales,Junior,,2026-02-01,,,,,,`;

        const response = await reportCsvAs(csv, true);

        expect(response.status).toBe(200);
        expect(await countEmployees()).toBe(before);
      });

      it('given HR Viewer, when they ask for the report, then it is refused', async () => {
        /* The report contains the file that was uploaded. It follows the same rule as
           the import itself rather than the export's. */
        const response = await request(harness.app)
          .post('/api/employees/import?report=csv')
          .set('Authorization', signins.as('hr.viewer@acme.test'))
          .set('Content-Type', 'text/csv')
          .send(badFile);

        expect(response.status).toBe(403);
      });
    });

    it('given a file with any problem, when applied, then nothing at all is written', async () => {
      /* All of it or none of it. Writing the good rows leaves the company missing
         people with no record of which, and the corrected file cannot be uploaded
         again because the good rows would now collide. */
      const before = await countEmployees();
      const csv = [
        HEADER,
        'Would Work,partial1@acme.test,US,Sales,Junior,,2026-02-01,,,,,,',
        'Would Not,partial2@acme.test,ZZZ,Nope,Nope,,not-a-date,,,,,,',
      ].join('\n');

      const report = reportOf(await importAs('hr.admin@acme.test', csv, true));

      expect(report.applied).toBe(false);
      expect(report.created).toBe(0);
      expect(await countEmployees()).toBe(before);
    });

    it('given a clean file, when applied, then everybody is created with their salary', async () => {
      const csv = [
        HEADER,
        'Imported One,imp1@acme.test,GB,Engineering,Senior,Staff Engineer,2026-03-01,ACTIVE,,,90000.00,GBP,2026-03-01',
        'Imported Two,imp2@acme.test,GB,Engineering,Junior,,2026-03-01,,,imp1@acme.test,45000.00,GBP,2026-03-01',
      ].join('\n');

      const report = reportOf(await importAs('hr.admin@acme.test', csv, true));

      expect(report).toMatchObject({ applied: true, created: 2, problemCount: 0 });

      const created = await request(harness.app)
        .get('/api/employees?q=imp1@acme.test')
        .set('Authorization', signins.as('hr.admin@acme.test'));
      const rows = (
        bodyOf(created) as unknown as {
          rows: { fullName: string; salary: { amountMinor: number } | null }[];
        }
      ).rows;

      expect(rows[0]?.salary?.amountMinor).toBe(9_000_000);
    });

    it('given a manager listed after their report, when applied, then the link is still made', async () => {
      /* A spreadsheet has no reason to be sorted by seniority. The insertion order
         is worked out rather than patched up with a second UPDATE pass. */
      const csv = [
        HEADER,
        'Report First,rf@acme.test,GB,Engineering,Junior,,2026-04-01,,,mf@acme.test,40000.00,GBP,2026-04-01',
        'Manager Second,mf@acme.test,GB,Engineering,Senior,,2026-04-01,,,,95000.00,GBP,2026-04-01',
      ].join('\n');

      const report = reportOf(await importAs('hr.admin@acme.test', csv, true));
      expect(report.created).toBe(2);

      const found = await request(harness.app)
        .get('/api/employees?q=rf@acme.test')
        .set('Authorization', signins.as('hr.admin@acme.test'));
      const rows = (bodyOf(found) as unknown as { rows: { managerName: string | null }[] }).rows;

      expect(rows[0]?.managerName).toBe('Manager Second');
    });

    it('given a manager who is already in the database, when applied, then they are found by address', async () => {
      const csv = `${HEADER}\nJoins Team,joins@acme.test,US,Sales,Junior,,2026-05-01,,,outside.lead@acme.test,70000.00,USD,2026-05-01`;

      const report = reportOf(await importAs('hr.admin@acme.test', csv, true));

      expect(report.created).toBe(1);
    });

    it('given two people who manage each other, when previewed, then the cycle is reported rather than broken', async () => {
      const csv = [
        HEADER,
        'Cycle A,ca@acme.test,US,Sales,Junior,,2026-06-01,,,cb@acme.test,,,',
        'Cycle B,cb@acme.test,US,Sales,Junior,,2026-06-01,,,ca@acme.test,,,',
      ].join('\n');

      const report = reportOf(await importAs('hr.admin@acme.test', csv));

      expect(report.validRows).toBe(0);
      expect(report.problems[0]?.message).toContain('managing each other');
    });

    it('given a manager who is nowhere, when previewed, then the row is reported', async () => {
      const csv = `${HEADER}\nOrphan,orphan@acme.test,US,Sales,Junior,,2026-06-01,,,ghost@acme.test,,,`;

      const report = reportOf(await importAs('hr.admin@acme.test', csv));

      expect(report.problems[0]?.column).toBe('managerEmail');
    });

    it('given a leaver with a leaving date, when applied, then both are stored', async () => {
      const csv = `${HEADER}\nAlready Gone,gone.import@acme.test,US,Sales,Junior,,2024-01-01,LEFT,2025-12-31,,60000.00,USD,2024-01-01`;

      const report = reportOf(await importAs('hr.admin@acme.test', csv, true));
      expect(report.created).toBe(1);

      const found = await request(harness.app)
        .get('/api/employees?q=gone.import@acme.test&status=LEFT')
        .set('Authorization', signins.as('hr.admin@acme.test'));
      const rows = (
        bodyOf(found) as unknown as { rows: { status: string; leftOn: string | null }[] }
      ).rows;

      expect(rows[0]).toMatchObject({ status: 'LEFT', leftOn: '2025-12-31' });
    });

    it('given a body that is not CSV, when imported, then it is reported as an empty file', async () => {
      const response = await request(harness.app)
        .post('/api/employees/import')
        .set('Authorization', signins.as('hr.admin@acme.test'))
        .send({ not: 'csv' });

      expect(response.status).toBe(200);
      expect(reportOf(response).problems[0]?.message).toContain('empty');
    });
  });

  describe('the round trip', () => {
    it('given the whole company exported, when the same file is previewed, then every row is refused only for already existing', async () => {
      /**
       * The strongest available check that the two halves agree on thirteen columns.
       *
       * Every row is expected to be refused, and refused for exactly one reason:
       * the address is already taken. Any *other* problem would mean the export
       * writes something the importer cannot read — a date in the wrong format, an
       * amount with a separator, a department name it cannot resolve.
       */
      const exported = (await exportAs('hr.admin@acme.test')).text;

      const report = reportOf(await importAs('hr.admin@acme.test', exported));

      expect(report.totalRows).toBeGreaterThan(30);
      expect(report.problemCount).toBe(report.totalRows);
      expect(
        report.problems.every((problem) => problem.message.includes('already has that email')),
      ).toBe(true);
    });
  });

  async function countEmployees(): Promise<number> {
    const response = await request(harness.app)
      .get('/api/employees?pageSize=25')
      .set('Authorization', signins.as('hr.admin@acme.test'));

    return (bodyOf(response) as unknown as { total: number }).total;
  }
});
