import { parseCsv, toCsvLine } from '../../src/domain/csv';

/**
 * The parser earns its existence in the first block below: a name containing a
 * comma. Splitting on commas gains a column on that row, every field after it
 * shifts, and a hire date lands in the salary column — a failure that produces
 * plausible data rather than an error.
 */

describe('parseCsv', () => {
  describe('the ordinary shape', () => {
    it('given a header and two rows, when parsed, then the fields come back in order', () => {
      expect(parseCsv('a,b\n1,2\n3,4')).toEqual([
        ['a', 'b'],
        ['1', '2'],
        ['3', '4'],
      ]);
    });

    it('given windows line endings, when parsed, then the carriage returns are not part of the fields', () => {
      expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
        ['a', 'b'],
        ['1', '2'],
      ]);
    });

    it('given a final row with no trailing newline, when parsed, then it is still a row', () => {
      expect(parseCsv('a\n1')).toEqual([['a'], ['1']]);
    });

    it('given a byte-order mark, as Excel writes, when parsed, then the first header is not corrupted', () => {
      expect(parseCsv('﻿fullName,email\nAda,ada@acme.test')[0]).toEqual(['fullName', 'email']);
    });

    it('given surrounding spaces on an unquoted field, when parsed, then they are trimmed', () => {
      expect(parseCsv('a , b\n 1 , 2 ')).toEqual([
        ['a', 'b'],
        ['1', '2'],
      ]);
    });
  });

  describe('quoted fields', () => {
    it('given a comma inside quotes, when parsed, then the row keeps its column count', () => {
      expect(parseCsv('name,country\n"Smith, Jr.",US')).toEqual([
        ['name', 'country'],
        ['Smith, Jr.', 'US'],
      ]);
    });

    it('given a newline inside quotes, when parsed, then it stays inside one field', () => {
      expect(parseCsv('note\n"line one\nline two"')).toEqual([['note'], ['line one\nline two']]);
    });

    it('given doubled quotes inside quotes, when parsed, then they become one quote', () => {
      expect(parseCsv('name\n"Ada ""The Countess"" Lovelace"')).toEqual([
        ['name'],
        ['Ada "The Countess" Lovelace'],
      ]);
    });

    it('given a quoted field with spaces inside, when parsed, then the spaces are kept', () => {
      /* Quoting is how a file says "these spaces are deliberate", so a quoted field
         is not trimmed and an unquoted one is. */
      expect(parseCsv('name\n"  spaced  "')).toEqual([['name'], ['  spaced  ']]);
    });

    it('given a space before the opening quote, when parsed, then the field is still read as quoted', () => {
      expect(parseCsv('a,b\n1, "x,y"')).toEqual([
        ['a', 'b'],
        ['1', 'x,y'],
      ]);
    });
  });

  describe('empty lines and empty fields', () => {
    it('given a blank line between rows, when parsed, then it is skipped', () => {
      expect(parseCsv('a\n1\n\n2\n')).toEqual([['a'], ['1'], ['2']]);
    });

    it('given a line of only separators, when parsed, then it is a row of empty fields', () => {
      /* Not the same as a blank line: this is a row somebody left empty, and the
         importer has to report it rather than pretend it was not there. */
      expect(parseCsv('a,b,c\n,,')).toEqual([
        ['a', 'b', 'c'],
        ['', '', ''],
      ]);
    });

    it('given an empty string, when parsed, then there are no rows', () => {
      expect(parseCsv('')).toEqual([]);
    });

    it('given a ragged row, when parsed, then its own length is preserved for the caller to judge', () => {
      expect(parseCsv('a,b,c\n1,2')).toEqual([
        ['a', 'b', 'c'],
        ['1', '2'],
      ]);
    });
  });
});

describe('toCsvLine', () => {
  it('given plain values, when written, then they are unquoted and end with CRLF', () => {
    expect(toCsvLine(['a', 'b'])).toBe('a,b\r\n');
  });

  it('given a value with a comma, when written, then it is quoted', () => {
    expect(toCsvLine(['Smith, Jr.', 'US'])).toBe('"Smith, Jr.",US\r\n');
  });

  it('given a value with a quote, when written, then the quote is doubled', () => {
    expect(toCsvLine(['Ada "AL" Lovelace'])).toBe('"Ada ""AL"" Lovelace"\r\n');
  });

  it('given a value with a newline, when written, then it is quoted', () => {
    expect(toCsvLine(['one\ntwo'])).toBe('"one\ntwo"\r\n');
  });

  it('given a value with surrounding spaces, when written, then it is quoted so they survive', () => {
    expect(toCsvLine([' padded '])).toBe('" padded "\r\n');
  });

  it('given a value beginning with an equals sign, when written, then it cannot be read as a formula', () => {
    /* Excel treats a leading =, +, - or @ as a formula, so an exported name is one
       spreadsheet away from being something the machine tries to run. The leading
       apostrophe is the established fix. */
    expect(toCsvLine(['=SUM(A1:A9)'])).toBe("'=SUM(A1:A9)\r\n");
    expect(toCsvLine(['@acme'])).toBe("'@acme\r\n");
    expect(toCsvLine(['-3'])).toBe("'-3\r\n");
  });

  it('given a row written and read back, when round-tripped, then every value survives exactly', () => {
    const values = ['Smith, Jr.', 'Ada "AL" Lovelace', 'one\ntwo', '  spaced  ', ''];

    expect(parseCsv(toCsvLine(values))).toEqual([values]);
  });
});
