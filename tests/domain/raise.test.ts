import { MAX_AMOUNT_MINOR } from '../../src/domain/money';
import { parsePercentToBasisPoints, raisedAmountMinor } from '../../src/domain/raise';

/**
 * The arithmetic the preview and the apply share.
 *
 * The rounding test is the one that matters: half a cent has to go somewhere, the
 * choice is visible in a total across ten thousand people, and once a bulk raise is
 * applied to an append-only table there is no correcting it quietly.
 */

describe('parsePercentToBasisPoints', () => {
  describe('what it accepts', () => {
    it.each([
      ['3', 300],
      ['3.5', 350],
      ['3.25', 325],
      ['0.01', 1],
      ['100', 10_000],
      ['-2.5', -250],
      ['  4  ', 400],
    ])('given "%s", when parsed, then it is %i basis points', (input, expected) => {
      expect(parsePercentToBasisPoints(input)).toBe(expected);
    });
  });

  describe('what it refuses', () => {
    it.each(['', 'x', '3%', '3,5', '1e2', '3.', '.5', '+3', ' - 3'])(
      'given "%s", when parsed, then it is not a percentage',
      (input) => {
        expect(() => parsePercentToBasisPoints(input)).toThrow(TypeError);
      },
    );

    it('given three decimal places, when parsed, then it is refused rather than rounded', () => {
      /* Rounding it would mean the figure signed off and the figure applied are
         different numbers, which is the one thing this module exists to prevent. */
      expect(() => parsePercentToBasisPoints('3.555')).toThrow(TypeError);
    });

    it('given a figure beyond the supported range, when parsed, then it is refused', () => {
      expect(() => parsePercentToBasisPoints('101')).toThrow(RangeError);
      expect(() => parsePercentToBasisPoints('-101')).toThrow(RangeError);
    });

    it('given zero, when parsed, then it is refused because it would record every salary again', () => {
      expect(() => parsePercentToBasisPoints('0')).toThrow(RangeError);
      expect(() => parsePercentToBasisPoints('0.00')).toThrow(RangeError);
    });
  });
});

describe('raisedAmountMinor', () => {
  it('given a whole-percent raise on a round salary, when applied, then the arithmetic is exact', () => {
    // £50,000.00 plus 10% is £55,000.00, to the penny.
    expect(raisedAmountMinor(5_000_000, 1_000)).toBe(5_500_000);
  });

  it('given a raise landing on half a cent, when applied, then it rounds up as documented', () => {
    /* 1 cent at 50% is half a cent. Half away from zero is what a person expects
       and what the docs promise; the value of writing it down is that a reader can
       check the total rather than wonder. */
    expect(raisedAmountMinor(1, 5_000)).toBe(2);
  });

  it('given a raise landing just under half a cent, when applied, then it rounds down', () => {
    // 1 cent at 49% is 0.49 of a cent, which is no increase at all.
    expect(raisedAmountMinor(1, 4_900)).toBe(1);
  });

  it('given a cut, when applied, then the amount falls by the same rule', () => {
    expect(raisedAmountMinor(5_000_000, -1_000)).toBe(4_500_000);
  });

  it('given a large salary and a fractional percentage, when applied, then no value passes through a float', () => {
    // 12,345,678 cents at 3.33% is 411,111.0774, which rounds to 411,111.
    expect(raisedAmountMinor(12_345_678, 333)).toBe(12_345_678 + 411_111);
  });

  it('given a cut landing on exactly half a cent, when applied, then it rounds up and the cut is the smaller one', () => {
    /* The direction that needs writing down. A 2.5-cent reduction becomes 2, not 3,
       so a rounding decision never leaves somebody worse off. */
    expect(raisedAmountMinor(100, -250)).toBe(98);
  });

  it('given a cut that would round a salary to nothing, when applied, then it is refused', () => {
    expect(() => raisedAmountMinor(1, -10_000)).toThrow(RangeError);
  });

  it('given an amount at the exact ceiling and a raise, when applied, then it is refused rather than losing precision', () => {
    expect(() => raisedAmountMinor(MAX_AMOUNT_MINOR, 100)).toThrow(RangeError);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'given %p as an amount, when raised, then it is refused as not whole minor units',
    (amount) => {
      expect(() => raisedAmountMinor(amount, 300)).toThrow(TypeError);
    },
  );

  describe('against a reference calculation', () => {
    it('given many salaries and percentages, when raised, then every result matches exact decimal arithmetic', () => {
      /* An independent expression of the same rule — add half the divisor and take
         the floor — rather than a second call to Math.round, which would only prove
         that Math.round agrees with itself. Exact at these magnitudes because the
         intermediate stays a whole number well inside the safe integer range. */
      const reference = (amount: number, basisPoints: number): number =>
        amount + Math.floor((amount * basisPoints + 5_000) / 10_000);

      for (const amount of [1, 99, 100, 1_234_567, 8_500_050, 99_999_999]) {
        for (const basisPoints of [1, 50, 250, 333, 1_000, 9_999, -250, -3_333]) {
          expect(raisedAmountMinor(amount, basisPoints)).toBe(reference(amount, basisPoints));
        }
      }
    });
  });
});
