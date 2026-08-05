import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { isValidIsoDate } from '../domain/dates';
import { SUPPORTED_CURRENCIES } from '../domain/money';
import { HTTP_STATUS, notFound } from '../errors';
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
  asOf: z.string().refine(isValidIsoDate, 'asOf must be a date as YYYY-MM-DD.').optional(),
});

/** A date on its own, for the endpoints that take nothing else. */
const asOfSchema = z.object({
  asOf: z.string().refine(isValidIsoDate, 'asOf must be a date as YYYY-MM-DD.').optional(),
});

/**
 * `:id` from the path. Coerced and checked here so a request for
 * /api/employees/abc is a 400 about the parameter rather than a database error
 * about a failed cast.
 */
const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

/** A note on a raise, not an essay. Long enough for "Promotion to Senior, Q3 review". */
const MAX_REASON_LENGTH = 500;

/**
 * A new salary.
 *
 * The amount is a **string**, deliberately. JSON numbers are doubles, so 85000.1
 * arrives as 85000.099999999999 and a client cannot express an exact amount even
 * when it has one. A string carries the digits the user typed, and
 * `parseAmountToMinor` refuses anything that is not a clean two-decimal figure
 * rather than rounding it into something plausible.
 */
const recordPaySchema = z.object({
  /* Bounded so a rejection message, which quotes what was sent, cannot be made
     into a payload by sending a very long one. No real amount is 32 characters. */
  amount: z.string().trim().min(1, 'An amount is required.').max(32),
  currency: z.enum(SUPPORTED_CURRENCIES),
  effectiveFrom: z.string().refine(isValidIsoDate, 'effectiveFrom must be a date as YYYY-MM-DD.'),
  reason: z.string().trim().max(MAX_REASON_LENGTH).optional(),
});

/** Long enough for the longest real names; short enough not to be a payload. */
const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const MAX_JOB_TITLE_LENGTH = 120;

/**
 * A new employee.
 *
 * The starting salary is optional and nested rather than flattened: a record is
 * often created before the offer is signed off, and the three fields only mean
 * anything together. Nesting them means "no salary yet" is one absent object
 * rather than three fields that have to agree about being empty.
 */
const createEmployeeSchema = z.object({
  fullName: z.string().trim().min(1, 'A name is required.').max(MAX_NAME_LENGTH),
  /* Tidied first, then checked: an address pasted with a trailing space is a
     typing accident rather than an invalid address. The length bound is the
     254-octet limit on a real one — anything longer is a payload. */
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email('That is not an email address.').max(MAX_EMAIL_LENGTH)),
  country: z
    .string()
    .regex(COUNTRY_PATTERN, 'country must be a two-letter code.')
    .transform((value) => value.toUpperCase()),
  departmentId: z.coerce.number().int().positive(),
  jobLevelId: z.coerce.number().int().positive(),
  jobTitle: z.string().trim().max(MAX_JOB_TITLE_LENGTH).optional(),
  hireDate: z.string().refine(isValidIsoDate, 'hireDate must be a date as YYYY-MM-DD.'),
  managerId: z.coerce.number().int().positive().optional(),
  status: z.enum(['ACTIVE', 'LEFT']).optional(),
  startingPay: z
    .object({
      amount: z.string().trim().min(1, 'An amount is required.').max(32),
      currency: z.enum(SUPPORTED_CURRENCIES),
      effectiveFrom: z
        .string()
        .refine(isValidIsoDate, 'effectiveFrom must be a date as YYYY-MM-DD.')
        .optional(),
    })
    .optional(),
});

export interface EmployeeRouterDeps {
  employees: EmployeeService;
  requireAuth: RequestHandler;
  /** Only HR Admin may write. Passed in so the router does not build its own guard. */
  requireHrAdmin: RequestHandler;
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

  router.post('/', deps.requireAuth, deps.requireHrAdmin, async (req, res) => {
    const body = createEmployeeSchema.parse(req.body);
    const { role, employeeId, userId } = authContext(req);

    const detail = await deps.employees.create(
      { role, employeeId },
      {
        fullName: body.fullName,
        email: body.email,
        country: body.country,
        departmentId: body.departmentId,
        jobLevelId: body.jobLevelId,
        ...(body.jobTitle === undefined || body.jobTitle === '' ? {} : { jobTitle: body.jobTitle }),
        hireDate: body.hireDate,
        ...(body.managerId === undefined ? {} : { managerId: body.managerId }),
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.startingPay === undefined ? {} : { startingPay: body.startingPay }),
        /* From the verified token, never from the body. A client that can name
           its own author can sign somebody else's name to a pay record. */
        createdByUserId: userId,
      },
    );

    // 201 with the record: the client navigates straight to it, no second call.
    res.status(HTTP_STATUS.CREATED).json(detail);
  });

  router.get('/:id', deps.requireAuth, async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    const { asOf } = asOfSchema.parse(req.query);
    const { role, employeeId } = authContext(req);

    const detail = await deps.employees.findById(
      { role, employeeId },
      { id, ...(asOf === undefined ? {} : { asOf }) },
    );

    if (detail === null) {
      /* 404 rather than 403, and the same message either way. A 403 on somebody
         else's record confirms that the record exists — which is enough to walk
         the ids and learn the shape of the company. */
      throw notFound('No such employee.');
    }

    res.status(HTTP_STATUS.OK).json(detail);
  });

  router.post('/:id/compensation', deps.requireAuth, deps.requireHrAdmin, async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    const body = recordPaySchema.parse(req.body);
    const { role, employeeId, userId } = authContext(req);

    const detail = await deps.employees.recordPay(
      { role, employeeId },
      {
        employeeId: id,
        amount: body.amount,
        currency: body.currency,
        effectiveFrom: body.effectiveFrom,
        ...(body.reason === undefined ? {} : { reason: body.reason }),
        /* From the verified token, never from the body. A client that can name
           its own author can sign somebody else's name to a pay change. */
        recordedByUserId: userId,
      },
    );

    if (detail === null) {
      throw notFound('No such employee.');
    }

    res.status(HTTP_STATUS.OK).json(detail);
  });

  return router;
}
