import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { HTTP_STATUS } from '../shared/errors';
import { authContext } from '../middleware/requireAuth';
import type { EmployeeCsvService } from '../services/employeeCsv';
import {
  employeeFilterSchema,
  employeeStatusSchema,
  isoDateSchema,
  MAX_SEARCH_LENGTH,
} from './schemas';

/**
 * The spreadsheet in and the spreadsheet out.
 *
 * Its own router rather than more routes on the employee one, because both of
 * these are about a file: one streams a response instead of returning JSON, the
 * other needs a body parser and a size limit nothing else on the API wants.
 */

/** The same filters as the list. Export applies them; it just ignores the paging. */
const exportQuerySchema = employeeFilterSchema.extend({
  q: z.string().trim().max(MAX_SEARCH_LENGTH).optional(),
  status: employeeStatusSchema.optional(),
  asOf: isoDateSchema('asOf').optional(),
});

/**
 * Whether to write.
 *
 * A query parameter rather than two endpoints, because preview and apply are one
 * operation in the service — the guarantee that the preview matches what is
 * applied comes from their being the same code, and two URLs would invite them to
 * stop being.
 *
 * Defaults to preview. Getting a dry run when you wanted the real thing costs a
 * second request; the other way round costs an append-only table full of raises.
 */
const importQuerySchema = z.object({
  apply: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * Ask for the annotated file instead of the JSON report.
   *
   * The same file, validated the same way — so what somebody downloads to work from
   * cannot disagree with the screen they are looking at. It reaches a different service
   * operation, one that has no `apply` parameter at all: a report of what is wrong with
   * a file is not a thing that can also import it, and a signature that cannot express
   * the combination is better than a line of code that ignores it.
   */
  report: z.enum(['csv']).optional(),
});

export interface EmployeeCsvRouterDeps {
  employeeCsv: EmployeeCsvService;
  requireAuth: RequestHandler;
  requireHrAdmin: RequestHandler;
  /** Reads a text/csv body, mounted only here. See the limit in app.ts. */
  csvBodyParser: RequestHandler;
}

export function createEmployeeCsvRouter(deps: EmployeeCsvRouterDeps): Router {
  const router = Router();

  /**
   * The current view as a file.
   *
   * Written as it is read rather than assembled and sent, so the process never
   * holds the whole company in memory. That also means the status line goes out
   * before the last row is known — a failure partway through arrives as a
   * truncated file rather than a 500, which is why the header row is written first
   * and the client is told the length is unknown.
   */
  router.get('/export', deps.requireAuth, async (req, res) => {
    const query = exportQuerySchema.parse(req.query);
    const { role, employeeId } = authContext(req);

    const rows = deps.employeeCsv.exportRows(
      { role, employeeId },
      {
        search: query.q,
        country: query.country,
        departmentId: query.departmentId,
        jobLevelId: query.jobLevelId,
        status: query.status,
        asOf: query.asOf,
      },
    );

    res.status(HTTP_STATUS.OK);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    /* Every salary the caller may see, in one file. Nothing in between may hold
       it, and the browser must not either. */
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="acme-employees-${query.asOf ?? 'today'}.csv"`,
    );

    for await (const line of rows) {
      /* Back-pressure: when the socket's buffer is full, write returns false and
         this waits for it to drain. Without it a fast database and a slow client
         mean the whole file queues in this process's memory, which is the thing
         streaming was supposed to avoid. */
      if (!res.write(line)) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }

    res.end();
  });

  router.post(
    '/import',
    deps.requireAuth,
    deps.requireHrAdmin,
    deps.csvBodyParser,
    async (req, res) => {
      const { apply, report: format } = importQuerySchema.parse(req.query);
      const { role, employeeId, userId } = authContext(req);
      const subject = { role, employeeId };

      /* The parser leaves an empty string for a body of the wrong content type,
         which is a clearer thing to report than a parse of nothing. */
      const csv = typeof req.body === 'string' ? req.body : '';

      /* Somebody's name, email and salary, either way. Nothing in between may hold it
         and the browser must not either — the same rule the export follows. */
      res.setHeader('Cache-Control', 'no-store');

      if (format === 'csv') {
        const problems = await deps.employeeCsv.problemReportCsv(subject, csv);

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="acme-import-problems.csv"');
        res.status(HTTP_STATUS.OK).send(problems);
        return;
      }

      const report = await deps.employeeCsv.importRows(subject, {
        csv,
        apply,
        importedByUserId: userId,
      });

      /* 200 either way, including for a preview that found problems. The request
         succeeded — it asked what would happen and was told. A 400 would be for a
         request that could not be understood, and would push a client into
         treating "your file has 158 errors" as a failure to report them. */
      res.status(HTTP_STATUS.OK).json(report);
    },
  );

  return router;
}
