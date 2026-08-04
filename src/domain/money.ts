/**
 * Money is handled as whole minor units — 8500050 is $85,000.50 — because
 * decimal arithmetic is inexact and summing 10,000 salaries drifts.
 *
 * Everything here is a pure function. No database, no formatting for display:
 * the API returns minor units plus a currency code, and the UI formats them
 * for the reader's locale.
 */

/** Every supported currency has exactly two decimal places. */
export const MINOR_UNITS_PER_MAJOR = 100;

const MINOR_UNIT_DIGITS = 2;

/**
 * Largest amount that stays exact — about $90tn in cents. Beyond this, integer
 * arithmetic in JavaScript starts approximating.
 *
 * The database enforces the same ceiling; schema.ts imports this so the rule has
 * one definition rather than a matching literal in two layers.
 */
export const MAX_AMOUNT_MINOR = Number.MAX_SAFE_INTEGER;

/**
 * Deliberately limited to two-decimal currencies. JPY has no minor unit and
 * KWD has three, so both would need a per-currency exponent threaded through
 * every calculation. See docs/requirements.md.
 */
export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD'] as const;

export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/** Digits, with an optional two-decimal fraction. No sign, no exponent. */
const AMOUNT_PATTERN = /^(\d+)(?:\.(\d+))?$/;

export function isSupportedCurrency(code: string): code is Currency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(code);
}

export function assertSupportedCurrency(code: string): Currency {
  if (!isSupportedCurrency(code)) {
    throw new RangeError(
      `Unsupported currency ${code}. Supported: ${SUPPORTED_CURRENCIES.join(', ')}.`,
    );
  }
  return code;
}

/**
 * Parses a canonical decimal amount into whole minor units: "85000.50" is
 * 8500050. A full stop is the only accepted decimal separator, and group
 * separators are refused.
 *
 * This deliberately knows nothing about locales. Stripping commas before
 * parsing looks helpful and is dangerous: half of Europe writes 85000,50 for
 * eighty-five thousand, which would strip to 8500050 and be read as eight and a
 * half million — a hundredfold overpayment that passes every later check and
 * lands in an append-only table. Nor can a stricter grouping rule fix it, since
 * Indian formatting groups as 85,00,000 and western as 8,500,000.
 *
 * A caller that has locale information — the CSV importer, which knows the
 * source file — normalises before calling. Guessing here has no safe answer.
 *
 * Throws rather than rounding or coercing: a rejected import row is better than
 * a quietly altered salary. Never uses parseFloat; the digits are combined with
 * integer arithmetic, so no value passes through a float.
 */
export function parseAmountToMinor(input: string | number): number {
  const text = typeof input === 'number' ? numberToPlainString(input) : input.trim();

  if (text.includes(',')) {
    throw new TypeError(
      `"${String(input)}" contains a separator. Amounts must be plain digits with an optional "." decimal point, such as 85000.50.`,
    );
  }

  const match = AMOUNT_PATTERN.exec(text);

  if (!match) {
    throw new TypeError(`"${String(input)}" is not a valid amount.`);
  }

  const [, whole = '', fraction = ''] = match;

  if (fraction.length > MINOR_UNIT_DIGITS) {
    throw new RangeError(
      `"${String(input)}" has more than two decimal places, which this currency cannot represent.`,
    );
  }

  const minor =
    Number(whole) * MINOR_UNITS_PER_MAJOR + Number(fraction.padEnd(MINOR_UNIT_DIGITS, '0'));

  if (!Number.isSafeInteger(minor) || minor > MAX_AMOUNT_MINOR) {
    throw new RangeError(`"${String(input)}" is too large to hold as an exact amount.`);
  }

  /* Zero is refused here rather than left to the database. Nobody is paid
     nothing, and the same rule as a check constraint means a zero arrives as a
     rejected input instead of a failed insert. Raise differences can be
     negative, but those are computed, not parsed. */
  if (minor === 0) {
    throw new RangeError(`"${String(input)}" is not a payable amount.`);
  }

  return minor;
}

/**
 * Renders minor units as a plain decimal string: 8500050 becomes "85000.50".
 *
 * No thousands separators and no currency symbol — this output feeds CSV, where
 * a comma would split the column, and API responses, where the UI does the
 * locale-aware formatting.
 */
export function formatMinorToDecimal(minor: number): string {
  if (!Number.isSafeInteger(minor)) {
    throw new TypeError(`${minor} is not whole minor units.`);
  }

  const sign = minor < 0 ? '-' : '';
  const absolute = Math.abs(minor);
  const major = Math.trunc(absolute / MINOR_UNITS_PER_MAJOR);
  const fraction = absolute % MINOR_UNITS_PER_MAJOR;

  return `${sign}${major}.${String(fraction).padStart(MINOR_UNIT_DIGITS, '0')}`;
}

/**
 * Rejects NaN and Infinity, then hands the digits over unchanged.
 *
 * Deliberately not toFixed(2), which would round: a number with three decimal
 * places has to be refused for the same reason the string form is, or the same
 * salary would be accepted or rejected depending on how the client encoded it.
 * String() also renders very large values in exponent notation, which the
 * amount pattern then rejects.
 */
function numberToPlainString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`"${String(value)}" is not a valid amount.`);
  }
  return String(value);
}
