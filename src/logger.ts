/**
 * One line of JSON per event, so a log aggregator can filter on fields rather
 * than on regular expressions over prose.
 *
 * Everything logged is passed through `redact` first. Salaries, passwords and
 * tokens all pass through this process, and a log is the easiest place to leak
 * them by accident — a caught error object carrying a query, a request body
 * spread into a field. Redaction here means no call site has to remember.
 */

const REDACTED = '[redacted]';

/**
 * Matched against field names, not values. Deliberately broad: a field called
 * `refreshToken`, `passwordHash` or `authorization` has nothing to contribute to
 * a log line, so over-redacting costs nothing and under-redacting is a leak.
 */
const SENSITIVE_KEY_PATTERN = /pass|token|secret|credential|authorization|cookie|hash/i;

/** Deep enough for real log payloads; a bound rather than a promise about shape. */
const MAX_DEPTH = 4;

export type LogFields = Record<string, unknown>;

export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return '[truncated]';
  }
  // A caught error can hold a `cause` chain that loops back on itself.
  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  const result: LogFields = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return result;
}

/**
 * Enough of an address to recognise an account in a support conversation, without
 * writing somebody's email into every failed-login line. The domain stays because
 * it distinguishes a typo from an outsider probing the login form.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) {
    return REDACTED;
  }
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

function emit(level: 'info' | 'warn' | 'error', event: string, fields: LogFields): void {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    event,
    ...(redact(fields) as LogFields),
  });

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (event: string, fields: LogFields = {}) => emit('info', event, fields),
  warn: (event: string, fields: LogFields = {}) => emit('warn', event, fields),
  error: (event: string, fields: LogFields = {}) => emit('error', event, fields),
};
