import type { Response } from 'supertest';

/**
 * Narrowing supertest's response body, which is typed `any`.
 *
 * Reaching into `any` would let a test keep passing after the response shape
 * changed — `response.body.user.role` on a body that no longer has a user is
 * `undefined`, and `expect(undefined).toBeUndefined()` is happy. These check what
 * they claim and throw with the actual body when it is not there.
 */

export interface ErrorShape {
  code: string;
  message: string;
  details?: { field: string; message: string }[];
}

export function bodyOf(response: Response): Record<string, unknown> {
  const body: unknown = response.body;

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`Expected a JSON object body, got: ${JSON.stringify(body)}`);
  }
  return body as Record<string, unknown>;
}

/** The `error` member of a failure response, as the error handler writes it. */
export function errorOf(response: Response): ErrorShape {
  const error = bodyOf(response)['error'];

  if (typeof error !== 'object' || error === null) {
    throw new Error(`Expected an error body, got: ${JSON.stringify(response.body)}`);
  }
  return error as ErrorShape;
}

/** The access token from a login or refresh response, insisting it is really there. */
export function accessTokenFrom(response: Response): string {
  const token = bodyOf(response)['accessToken'];

  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`Expected an access token, got: ${JSON.stringify(response.body)}`);
  }
  return token;
}
