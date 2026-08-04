import type { Response } from 'supertest';

/**
 * Reading Set-Cookie by hand rather than letting supertest's agent hold the
 * cookie jar: rotation tests need the *previous* token, which is exactly what a
 * cookie jar throws away.
 */
export function cookieFor(response: Response, name: string): string {
  const header: unknown = response.headers['set-cookie'];
  const cookies = Array.isArray(header) ? (header as string[]) : [String(header)];
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));

  if (cookie === undefined) {
    throw new Error(`Expected a ${name} cookie, got: ${JSON.stringify(header)}`);
  }
  return cookie;
}

/** The cookie's value, or undefined if it was not set at all. */
export function cookieValue(response: Response, name: string): string | undefined {
  const header: unknown = response.headers['set-cookie'];
  if (header === undefined) {
    return undefined;
  }

  const [, value] = /^[^=]+=([^;]*)/.exec(cookieFor(response, name)) ?? [];
  return value;
}
