import {
  MINOR_UNITS_PER_MAJOR,
  SUPPORTED_CURRENCIES,
  assertSupportedCurrency,
  formatMinorToDecimal,
  isSupportedCurrency,
  parseAmountToMinor,
} from './money';

describe('parseAmountToMinor', () => {
  it('given a decimal amount, when parsed, then it becomes whole minor units', () => {
    expect(parseAmountToMinor('85000.50')).toBe(8_500_050);
  });

  it('given a whole amount, when parsed, then it is scaled by the minor unit', () => {
    expect(parseAmountToMinor('85000')).toBe(8_500_000);
  });

  it('given a single decimal place, when parsed, then the minor units are padded', () => {
    // '.5' is 50 cents, not 5.
    expect(parseAmountToMinor('85000.5')).toBe(8_500_050);
  });

  it.each(['0', '0.00', 0])('given %s, when parsed, then it is refused as unpayable', (input) => {
    // Nobody is paid nothing, and the database check says the same thing.
    expect(() => parseAmountToMinor(input)).toThrow(/not a payable amount/i);
  });

  it('given a number rather than a string, when parsed, then it is accepted', () => {
    // JSON bodies send numbers; the conversion must not go through float maths.
    expect(parseAmountToMinor(85000.5)).toBe(8_500_050);
    expect(parseAmountToMinor(0.29)).toBe(29);
  });

  it('given surrounding whitespace, when parsed, then it is trimmed', () => {
    // Unambiguous, unlike a separator.
    expect(parseAmountToMinor(' 85000.50 ')).toBe(8_500_050);
  });

  it('given a comma used as a decimal separator, when parsed, then it is refused rather than misread', () => {
    /* The reason separators are refused outright. Half of Europe writes 85000,50
       for eighty-five thousand; stripping the comma reads it as eight and a half
       million — a hundredfold overpayment that passes every later check and
       lands in an append-only table. This app supports EUR, so the input is
       expected, not hypothetical. */
    expect(() => parseAmountToMinor('85000,50')).toThrow(/separator/i);
  });

  it.each(['85,000.50', '85,00,000', '8,5,0.00'])(
    'given the group separators in %s, when parsed, then it is refused',
    (input) => {
      /* No grouping rule is safe across locales: western groups 8,500,000 and
         Indian groups 85,00,000. The CSV importer knows the source file's locale
         and normalises before calling; guessing here has no correct answer. */
      expect(() => parseAmountToMinor(input)).toThrow(/separator/i);
    },
  );

  it('given more than two decimal places, when parsed, then it is rejected', () => {
    // Rounding somebody's salary without being asked is worse than refusing it.
    expect(() => parseAmountToMinor('85000.505')).toThrow(/two decimal places/i);
  });

  it('given a number with extra decimal places, when parsed, then it is rejected like the string form', () => {
    /* The same amount must not be accepted or rejected depending on whether the
       client encoded it as a string or a number. */
    expect(() => parseAmountToMinor(85000.505)).toThrow(/two decimal places/i);
    expect(() => parseAmountToMinor(0.1 + 0.2)).toThrow(/two decimal places/i);
  });

  it('given invalid input, when parsed, then the error type says which kind of problem it is', () => {
    // The error middleware maps both to 400, and anything else to 500.
    expect(() => parseAmountToMinor('abc')).toThrow(TypeError);
    expect(() => parseAmountToMinor('1.234')).toThrow(RangeError);
  });

  it('given a negative amount, when parsed, then it is rejected', () => {
    expect(() => parseAmountToMinor('-100')).toThrow(/not a valid amount/i);
  });

  it.each([
    ['an empty string', ''],
    ['only whitespace', '   '],
    ['a currency symbol', '$85000'],
    ['text', 'eighty thousand'],
    ['a partial number', '85000.'],
    ['a bare decimal point', '.'],
    ['exponent notation', '8.5e4'],
    ['not a number', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
  ])('given %s, when parsed, then it is rejected', (_label, input) => {
    expect(() => parseAmountToMinor(input)).toThrow(/not a valid amount/i);
  });

  it('given an amount beyond exact integer arithmetic, when parsed, then it is rejected', () => {
    // Past 2^53 minor units the result would be silently approximate.
    expect(() => parseAmountToMinor('99999999999999999')).toThrow(/too large/i);
  });
});

describe('formatMinorToDecimal', () => {
  it('given minor units, when formatted, then it is a plain decimal string', () => {
    expect(formatMinorToDecimal(8_500_050)).toBe('85000.50');
  });

  it('given an amount under one major unit, when formatted, then it keeps a leading zero', () => {
    expect(formatMinorToDecimal(29)).toBe('0.29');
    expect(formatMinorToDecimal(5)).toBe('0.05');
    expect(formatMinorToDecimal(0)).toBe('0.00');
  });

  it('given a negative amount, when formatted, then the sign is kept', () => {
    // Raise previews show a difference, which can be negative.
    expect(formatMinorToDecimal(-8_500_050)).toBe('-85000.50');
  });

  it('given no thousands separators are wanted, when formatted, then none are added', () => {
    // This output feeds CSV, where a comma would split the column.
    expect(formatMinorToDecimal(1_234_567_89)).not.toContain(',');
  });

  it('given a non-integer, when formatted, then it is rejected', () => {
    expect(() => formatMinorToDecimal(85.5)).toThrow(/whole minor units/i);
  });
});

describe('round trip', () => {
  it.each(['0.01', '0.99', '1', '85000.50', '99999999.99'])(
    'given %s, when parsed and formatted back, then the value is unchanged',
    (amount) => {
      expect(formatMinorToDecimal(parseAmountToMinor(amount))).toBe(Number(amount).toFixed(2));
    },
  );
});

describe('currencies', () => {
  it('given the supported set, when checked, then it is the documented six', () => {
    // Every currency here has exactly two decimal places, which the maths assumes.
    expect(SUPPORTED_CURRENCIES).toEqual(['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD']);
    expect(MINOR_UNITS_PER_MAJOR).toBe(100);
  });

  it('given a supported code, when checked, then it is recognised', () => {
    expect(isSupportedCurrency('INR')).toBe(true);
  });

  it.each(['JPY', 'KWD', 'usd', '', 'DOLLAR'])(
    'given %s, when checked, then it is not supported',
    (code) => {
      expect(isSupportedCurrency(code)).toBe(false);
    },
  );

  it('given an unsupported code, when asserted, then it names the currency', () => {
    // JPY has no minor unit and KWD has three, so both would break the arithmetic.
    expect(() => assertSupportedCurrency('JPY')).toThrow(/JPY/);
  });
});
