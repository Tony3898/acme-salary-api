/**
 * The errors a request can fail with, and the shape they reach the client in.
 *
 * Two rules hold everywhere below:
 *
 * - A client gets a stable `code` to branch on and a message safe to display.
 *   Nothing derived from a database error, a file path or a stack trace is ever
 *   put in a response — those go to the log instead.
 * - Anything the caller could use to probe the system gets a deliberately vague
 *   message. `INVALID_CREDENTIALS` is the clearest case: saying "no such account"
 *   would turn the login form into a list of who works here.
 */

export const HTTP_STATUS = {
  OK: 200,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
} as const;

export const ERROR_CODES = [
  'INVALID_REQUEST',
  'INVALID_CREDENTIALS',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** An error whose status and message were chosen for the client to see. */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The one answer to a failed login, whether the email is unknown or the password
 * is wrong. Both branches must reach this same error, or the response tells an
 * attacker which emails have accounts.
 */
export function invalidCredentials(): AppError {
  return new AppError(
    HTTP_STATUS.UNAUTHORIZED,
    'INVALID_CREDENTIALS',
    'Email or password is incorrect.',
  );
}

/**
 * No usable session. Expired, tampered, missing and revoked all arrive here with
 * the same message: which one it was is not the client's business, and the client
 * does the same thing in every case — try to refresh, then send the user to the
 * login page.
 */
export function unauthenticated(message = 'Sign in to continue.'): AppError {
  return new AppError(HTTP_STATUS.UNAUTHORIZED, 'UNAUTHENTICATED', message);
}

/** Authenticated, but this role is not allowed to do it. */
export function forbidden(message = 'Your role does not allow this.'): AppError {
  return new AppError(HTTP_STATUS.FORBIDDEN, 'FORBIDDEN', message);
}

export function notFound(message = 'Not found.'): AppError {
  return new AppError(HTTP_STATUS.NOT_FOUND, 'NOT_FOUND', message);
}

export function rateLimited(message = 'Too many attempts. Try again shortly.'): AppError {
  return new AppError(HTTP_STATUS.TOO_MANY_REQUESTS, 'RATE_LIMITED', message);
}
