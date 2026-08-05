import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../domain/money';
import { HTTP_STATUS, notFound } from '../shared/errors';
import { authContext } from '../middleware/requireAuth';
import { EMPLOYEE_SORT_FIELDS } from '../repositories/employees';
import type { EmployeeService } from '../services/employees';
import type { PayBandService } from '../services/payBands';
import {
  amountSchema,
  asOfSchema,
  countrySchema,
  employeeFilterSchema,
  employeeStatusSchema,
  idParamSchema,
  isoDateSchema,
  pagingSchema,
  MAX_EMAIL_LENGTH,
  MAX_JOB_TITLE_LENGTH,
  MAX_NAME_LENGTH,
  MAX_REASON_LENGTH,
  MAX_SEARCH_LENGTH,
  positiveIdSchema,
} from './schemas';

/**
 * One person's record: finding them, adding them, and the two things that change
 * about them.
 *
 * Every parameter is validated here, at the boundary, and nothing reaches the
 * query that was not on a list decided in advance.
 */

const listQuerySchema = pagingSchema.extend({
  ...employeeFilterSchema.shape,
  /* The sort column becomes part of the statement and cannot be a bound
     parameter, so anything not on this list is refused rather than sanitised. */
  sortBy: z.enum(EMPLOYEE_SORT_FIELDS).default('name'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
  q: z.string().trim().max(MAX_SEARCH_LENGTH).optional(),
  status: employeeStatusSchema.optional(),
  /* A closed set, because it becomes a condition rather than a value — and because
     the names have to match the ones on a person's own row or a link from the
     pay-bands screen would show a different set of people. */
  bandFit: z.enum(['BELOW', 'WITHIN', 'ABOVE', 'NO_BAND', 'NO_PAY', 'OTHER_CURRENCY']).optional(),
  asOf: isoDateSchema('asOf').optional(),
});

/** The needs-attention list: the same filters and the same paging as the list. */
const attentionQuerySchema = pagingSchema.extend({
  ...employeeFilterSchema.shape,
  asOf: isoDateSchema('asOf').optional(),
});

const recordPaySchema = z.object({
  amount: amountSchema,
  currency: z.enum(SUPPORTED_CURRENCIES),
  effectiveFrom: isoDateSchema('effectiveFrom'),
  reason: z.string().trim().max(MAX_REASON_LENGTH).optional(),
});

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
  country: countrySchema,
  departmentId: positiveIdSchema,
  jobLevelId: positiveIdSchema,
  jobTitle: z.string().trim().max(MAX_JOB_TITLE_LENGTH).optional(),
  hireDate: isoDateSchema('hireDate'),
  managerId: positiveIdSchema.optional(),
  status: employeeStatusSchema.optional(),
  leftOn: isoDateSchema('leftOn').optional(),
  startingPay: z
    .object({
      amount: amountSchema,
      currency: z.enum(SUPPORTED_CURRENCIES),
      effectiveFrom: isoDateSchema('effectiveFrom').optional(),
    })
    .optional(),
});

/**
 * Ending somebody's employment, or reversing it.
 *
 * Whether the date is required depends on the status, and that rule lives in the
 * service rather than here: it is the same rule the create path needs, and a
 * `superRefine` would put half of it in one file and half in another. The schema's
 * job is to establish that a date is a date.
 */
const changeStatusSchema = z.object({
  status: employeeStatusSchema,
  leftOn: isoDateSchema('leftOn').optional(),
});

export interface EmployeeRouterDeps {
  employees: EmployeeService;
  payBands: PayBandService;
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
        bandFit: query.bandFit,
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
        ...(body.leftOn === undefined ? {} : { leftOn: body.leftOn }),
        ...(body.startingPay === undefined ? {} : { startingPay: body.startingPay }),
        /* From the verified token, never from the body. A client that can name
           its own author can sign somebody else's name to a pay record. */
        createdByUserId: userId,
      },
    );

    // 201 with the record: the client navigates straight to it, no second call.
    res.status(HTTP_STATUS.CREATED).json(detail);
  });

  /**
   * Registered before `/:id`, and it has to be.
   *
   * Express matches in order, so with these the other way round "attention" would
   * be read as an id, fail the numeric coercion, and answer a 400 about a
   * parameter nobody sent.
   */
  router.get('/attention', deps.requireAuth, async (req, res) => {
    const query = attentionQuerySchema.parse(req.query);
    const { role, employeeId } = authContext(req);

    const page = await deps.payBands.needsAttention({ role, employeeId }, query);

    // Individual salaries. Never held by anything in between.
    res.setHeader('Cache-Control', 'no-store');
    res.status(HTTP_STATUS.OK).json(page);
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

  router.patch('/:id/status', deps.requireAuth, deps.requireHrAdmin, async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    const body = changeStatusSchema.parse(req.body);
    const { role, employeeId, userId } = authContext(req);

    const detail = await deps.employees.changeStatus(
      { role, employeeId },
      {
        employeeId: id,
        status: body.status,
        ...(body.leftOn === undefined ? {} : { leftOn: body.leftOn }),
        changedByUserId: userId,
      },
    );

    if (detail === null) {
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
