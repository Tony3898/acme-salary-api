/**
 * Reading and writing CSV, properly.
 *
 * Splitting on commas is the obvious approach and it is wrong for the first row
 * with a name like "Smith, Jr." in it — that row silently gains a column, every
 * field after it shifts by one, and a hire date lands in the salary column. So
 * this is a real parser: quoted fields, commas and newlines inside them, doubled
 * quotes as an escaped quote, and both line endings.
 *
 * No dependency, because the alternative is a package with its own streaming
 * abstraction for something that is a hundred lines and needs to be exactly
 * predictable. Pure functions throughout — a spreadsheet's worth of text goes in,
 * arrays of strings come out, and nothing here knows what an employee is.
 */

const QUOTE = '"';
const DELIMITER = ',';
/** A byte-order mark, which Excel writes at the front of a UTF-8 CSV. */
const BOM = '﻿';

/**
 * The characters that make a field need quoting on the way out. A leading or
 * trailing space is included: quoting it is what stops a reader trimming it away.
 */
const NEEDS_QUOTING = /[",\r\n]|^\s|\s$/;

/**
 * Rows of fields, in order, with empty trailing lines dropped.
 *
 * A row's length is whatever that line contained — this does not enforce a column
 * count, because "row 812 has 11 columns, expected 13" is a message the importer
 * can give with the header in hand, and a parser that throws cannot report the
 * other 9,000 rows in the same pass.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldWasQuoted = false;
  /* Whether anything at all has been seen on this line. Distinguishes a genuinely
     empty line, which is skipped, from a line of empty fields like ",,", which is
     a row of three blanks and a real error to report. */
  let started = false;

  const endField = (): void => {
    row.push(fieldWasQuoted ? field : field.trim());
    field = '';
    fieldWasQuoted = false;
  };

  const endRow = (): void => {
    endField();
    /* One empty field means the line held nothing. Dropped rather than reported,
       because a trailing newline at the end of a file is not an error and neither
       is a blank line between blocks somebody pasted. */
    if (!(row.length === 1 && row[0] === '')) {
      rows.push(row);
    }
    row = [];
    started = false;
  };

  const content = text.startsWith(BOM) ? text.slice(BOM.length) : text;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];

    if (quoted) {
      if (character === QUOTE) {
        // Two quotes inside a quoted field is one literal quote.
        if (content[index + 1] === QUOTE) {
          field += QUOTE;
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === QUOTE && field.trim() === '') {
      /* Opening a quoted field. Whitespace before the quote is discarded, which is
         what a spreadsheet does with `a, "b"`. */
      field = '';
      quoted = true;
      fieldWasQuoted = true;
      started = true;
    } else if (character === DELIMITER) {
      endField();
      started = true;
    } else if (character === '\n') {
      endRow();
    } else if (character === '\r') {
      // Part of CRLF; the \n that follows ends the row.
      continue;
    } else {
      field += character;
      started = true;
    }
  }

  // A final line with no trailing newline still counts.
  if (started || field !== '' || row.length > 0) {
    endRow();
  }

  return rows;
}

/**
 * One CSV line from a row of values, with a trailing newline.
 *
 * CRLF, because the file is opened in Excel more often than anywhere else and
 * Excel on Windows is the reason RFC 4180 says CRLF.
 */
export function toCsvLine(values: readonly string[]): string {
  return `${values.map(escapeField).join(DELIMITER)}\r\n`;
}

/**
 * Quotes a field when it needs it, and never otherwise.
 *
 * The leading-equals guard is not paranoia about the format, it is about the
 * program that opens it: Excel treats a field starting with =, +, - or @ as a
 * formula, so an exported name of `=cmd|...` becomes something a spreadsheet will
 * try to run. Prefixing a single quote is the established fix and keeps the value
 * readable.
 */
function escapeField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;

  return NEEDS_QUOTING.test(safe)
    ? `${QUOTE}${safe.replaceAll(QUOTE, QUOTE + QUOTE)}${QUOTE}`
    : safe;
}
