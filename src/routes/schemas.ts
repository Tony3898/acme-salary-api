import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, type PageSize } from '../services/employees';
import { isValidIsoDate } from '../domain/dates';

/**
 * The field shapes every route validates against, defined once.
 *
 * Five routers now ask for the same things — a date, a two-letter country, an id
 * in the path, a money amount as text — and each had written its own. The copies
 * had already begun to differ in their messages, and a bound that exists in four
 * places is a bound that will be raised in three.
 *
 * These are the outermost boundary: nothing below trusts its input, but this is
 * where a value stops being arbitrary text.
 */

/** Two letters, matching the column. Upper-cased so `gb` and `GB` are one filter. */
const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;

/** Long enough for the longest real names; short enough not to be a payload. */
export const MAX_NAME_LENGTH = 120;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_JOB_TITLE_LENGTH = 120;
/** A note on a raise, not an essay. Long enough for "Promotion to Senior, Q3 review". */
export const MAX_REASON_LENGTH = 500;
/** Long enough for a name or an address, short enough not to be a payload. */
export const MAX_SEARCH_LENGTH = 100;

export const countrySchema = z
  .string()
  .regex(COUNTRY_PATTERN, 'country must be a two-letter code.')
  .transform((value) => value.toUpperCase());

/**
 * A real calendar day, not merely the right shape: 2026-02-31 would otherwise
 * reach Postgres and be rejected there as a 500 instead of a 400.
 */
export function isoDateSchema(field: string): z.ZodString {
  return z.string().refine(isValidIsoDate, `${field} must be a date as YYYY-MM-DD.`);
}

/** Whether a caller has one date, and no other parameters. */
export const asOfSchema = z.object({ asOf: isoDateSchema('asOf').optional() });

/**
 * `:id` from the path. Coerced and checked here so a request for
 * /api/employees/abc is a 400 about the parameter rather than a database error
 * about a failed cast.
 */
export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export const positiveIdSchema = z.coerce.number().int().positive();

/**
 * A money amount, as a **string**, deliberately.
 *
 * JSON numbers are doubles, so 85000.1 arrives as 85000.099999999999 and a client
 * cannot express an exact amount even when it has one. A string carries the digits
 * the user typed, and `parseAmountToMinor` refuses anything that is not a clean
 * two-decimal figure rather than rounding it into something plausible.
 *
 * Bounded because a rejection message quotes what was sent, so a very long input
 * must not become a way to make the response a payload. No real amount is 32
 * characters.
 */
export const amountSchema = z.string().trim().min(1, 'An amount is required.').max(32);

export const employeeStatusSchema = z.enum(['ACTIVE', 'LEFT']);

/** The filters shared by the list, the statistics, the export and a bulk raise. */
export const employeeFilterSchema = z.object({
  country: countrySchema.optional(),
  departmentId: positiveIdSchema.optional(),
  jobLevelId: positiveIdSchema.optional(),
});

/**
 * Paging, for every endpoint that returns a page of people.
 *
 * `pageSize` is a closed set rather than a maximum: an arbitrary size lets a caller ask
 * for ten thousand rows in one request, and the point of paging is that nobody can.
 * Shared because two lists that disagree about their page sizes is a pager that lies on
 * one of them.
 */
export const pagingSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce
    .number()
    .int()
    .refine((value): value is PageSize => PAGE_SIZES.includes(value as never), {
      message: `pageSize must be one of ${PAGE_SIZES.join(', ')}.`,
    })
    .default(DEFAULT_PAGE_SIZE),
});
