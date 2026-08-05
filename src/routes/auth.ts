import {
  Router,
  type CookieOptions,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { z } from 'zod';
import { HTTP_STATUS } from '../shared/errors';
import { authContext } from '../middleware/requireAuth';
import type { AuthService, Session, SessionUser } from '../services/auth';

/**
 * The four endpoints a session needs. Each one validates its input, calls the
 * service, and turns the result into a response — no rules of its own.
 */

/** Read by the browser only as a cookie; the path keeps it off every other route. */
export const REFRESH_COOKIE_NAME = 'acme_refresh';
const REFRESH_COOKIE_PATH = '/api/auth';

/** RFC 5321's practical maximum. Longer is not an address, it is a payload. */
const MAX_EMAIL_LENGTH = 254;
/** A bound on what reaches argon2, so a huge body cannot become CPU time. */
const MAX_PASSWORD_LENGTH = 200;

/**
 * `req.cookies` is untyped, so it is narrowed here rather than trusted. A cookie
 * header can repeat a name, which makes the value an array — treating that as a
 * token would hand a hash of `[object Object]` to the lookup.
 */
function readCookie(req: Request, name: string): string | undefined {
  const cookies: unknown = req.cookies;
  if (typeof cookies !== 'object' || cookies === null) {
    return undefined;
  }
  const value = (cookies as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .max(MAX_EMAIL_LENGTH)
    .pipe(z.email('A valid email address is required.')),
  password: z.string().min(1, 'A password is required.').max(MAX_PASSWORD_LENGTH),
});

export interface AuthRouterDeps {
  auth: AuthService;
  /** Built once in app.ts, so this module never sees the signing secret. */
  requireAuth: RequestHandler;
  loginLimiter: RequestHandler;
  refreshLimiter: RequestHandler;
  /**
   * True in production. Drives both `secure` and `sameSite`, which have to move
   * together: a cross-site cookie is only accepted over HTTPS.
   */
  secureCookies: boolean;
}

export interface SessionResponse {
  accessToken: string;
  expiresInSeconds: number;
  user: SessionUser;
}

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();

  /**
   * The refresh token lives here and nowhere else.
   *
   * - `httpOnly` so no script can read it, which is why it is not in localStorage.
   * - `secure` and `sameSite: 'none'` in production, where the UI is on a
   *   different domain from the API. Locally both are on localhost, which counts
   *   as same-site, so `lax` works over plain http.
   * - `path` limited to the auth routes, so it is not attached to every request.
   *
   * With `sameSite: 'none'` another site can cause a refresh, but not benefit from
   * one: the new access token comes back in the response body, and the browser
   * will not let a cross-origin script read that. Keeping the access token out of
   * a cookie is what makes that true.
   */
  const refreshCookie = (expires: Date): CookieOptions => ({
    httpOnly: true,
    secure: deps.secureCookies,
    sameSite: deps.secureCookies ? 'none' : 'lax',
    path: REFRESH_COOKIE_PATH,
    expires,
  });

  const sendSession = (res: Response, session: Session): void => {
    res.cookie(
      REFRESH_COOKIE_NAME,
      session.refreshToken,
      refreshCookie(session.refreshTokenExpiresAt),
    );
    res.status(HTTP_STATUS.OK).json({
      accessToken: session.accessToken,
      expiresInSeconds: session.expiresInSeconds,
      user: session.user,
    } satisfies SessionResponse);
  };

  /* Rate limited ahead of validation, so an attacker cannot spend our argon2 time
     for free by sending well-formed guesses. */
  router.post('/login', deps.loginLimiter, async (req, res) => {
    const credentials = loginSchema.parse(req.body);
    const session = await deps.auth.login(credentials);

    sendSession(res, session);
  });

  router.post('/refresh', deps.refreshLimiter, async (req, res) => {
    const session = await deps.auth.refresh(readCookie(req, REFRESH_COOKIE_NAME));

    sendSession(res, session);
  });

  /**
   * Ends the session server-side and clears the cookie. Succeeds whatever was
   * presented — logging out is not something a client should be able to fail at.
   */
  router.post('/logout', async (req, res) => {
    await deps.auth.logout(readCookie(req, REFRESH_COOKIE_NAME));

    res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    res.status(HTTP_STATUS.NO_CONTENT).send();
  });

  /** Who the current token belongs to, re-read from the database rather than trusted from the token. */
  router.get('/me', deps.requireAuth, async (req, res) => {
    const user = await deps.auth.currentUser(authContext(req).userId);

    res.status(HTTP_STATUS.OK).json({ user });
  });

  return router;
}
