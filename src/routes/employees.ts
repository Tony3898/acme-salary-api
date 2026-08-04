import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { isValidIsoDate } from '../domain/dates';
import { HTTP_STATUS } from '../errors';
import { authContext } from '../middleware/requireAuth';
import { EMPLOYEE_SORT_FIELDS } from '../repositories/employees';
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, type EmployeeService } from '../services/employees';

/**
 * Reading employees. Every parameter is validated here, at the boundary, and
 * nothing reaches the query that was not on a list decided in advance.
 */

/** Two letters, matching the column. Upper-cased so `gb` and `GB` are one filter. */
const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;
/** Long enough for a name or an address, short enough not to be a payload. */
const MAX_SEARCH_LENGTH = 100;

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  /* A closed set rather than a maximum: an arbitrary size lets a caller ask for
     10,000 rows in one request, and the point of paging is that nobody can. */
  pageSize: z.coerce
    .number()
    .int()
    .refine((value): value is (typeof PAGE_SIZES)[number] => PAGE_SIZES.includes(value as never), {
      message: `pageSize must be one of ${PAGE_SIZES.join(', ')}.`,
    })
    .default(DEFAULT_PAGE_SIZE),
  /* The sort column becomes part of the statement and cannot be a bound
     parameter, so anything not on this list is refused rather than sanitised. */
  sortBy: z.enum(EMPLOYEE_SORT_FIELDS).default('name'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
  q: z.string().trim().max(MAX_SEARCH_LENGTH).optional(),
  country: z
    .string()
    .regex(COUNTRY_PATTERN, 'country must be a two-letter code.')
    .transform((value) => value.toUpperCase())
    .optional(),
  departmentId: z.coerce.number().int().positive().optional(),
  jobLevelId: z.coerce.number().int().positive().optional(),
  status: z.enum(['ACTIVE', 'LEFT']).optional(),
  /* A real calendar day, not merely the right shape: 2026-02-31 would otherwise
     reach Postgres and be rejected there as a 500 instead of a 400. */
  asOf: z
    .string()
    .refine(isValidIsoDate, 'asOf must be a date as YYYY-MM-DD.')
    .optional(),
});

export interface EmployeeRouterDeps {
  employees: EmployeeService;
  requireAuth: RequestHandler;
}

export function createEmployeeRouter(deps: EmployeeRouterDeps): Router {
  const router = Router();

  router.get('/', deps.requireAuth, async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    const { role, employeeId } = authContext(req);

    const page = await deps.employees.list(
      { role, employeeId },
      {
        page: query.page,
        pageSize: query.pageSize,
        sortBy: query.sortBy,
        sortDir: query.sortDir,
        search: query.q,
        country: query.country,
        departmentId: query.departmentId,
        jobLevelId: query.jobLevelId,
        status: query.status,
        asOf: query.asOf,
      },
    );

    res.status(HTTP_STATUS.OK).json(page);
  });

  return router;
}
