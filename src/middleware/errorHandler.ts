import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, HTTP_STATUS, notFound, type ErrorCode } from '../errors';
import { logger } from '../logger';

/**
 * The single place a failure becomes a response.
 *
 * Every route throws and lets this decide, so the response shape is identical
 * everywhere and no handler has to remember it. Express 5 forwards rejected
 * promises here on its own, so route handlers need no try/catch.
 */

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Only for validation failures: which field, and what was wrong with it. */
    details?: { field: string; message: string }[];
  };
}

/**
 * Nothing matched the URL. Handed to the error handler rather than answered here,
 * so there is exactly one piece of code that decides what a failure looks like.
 */
export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(notFound('No such endpoint.'));
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  /* A stream that has already started cannot be turned into an error response;
     Express's default handler closes the connection, which is the only honest
     outcome. Matters for the CSV export. */
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof AppError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message },
    } satisfies ErrorBody);
    return;
  }

  if (error instanceof ZodError) {
    /* Field-level detail is safe and useful here: the client sent these fields, so
       naming them reveals nothing it did not already know. */
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'The request could not be understood.',
        details: error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      },
    } satisfies ErrorBody);
    return;
  }

  /* Anything else is a bug. The detail goes to the log, where an operator can act
     on it; the client gets none of it, because a database error message carries
     table names, SQL and sometimes the values that were being written. */
  logger.error('request.failed', {
    method: req.method,
    path: req.path,
    cause: error instanceof Error ? error : { message: String(error) },
    stack: error instanceof Error ? error.stack : undefined,
  });

  res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
    error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' },
  } satisfies ErrorBody);
}
