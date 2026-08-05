import { BAND_WIDTH_BASIS_POINTS, bandStanding, type PayBand } from '../../src/domain/payBand';

/**
 * The comparison itself, with no database anywhere near it.
 *
 * The case worth the most attention is the one that refuses to answer: a salary in
 * one currency against a band in another. Converting would produce a plausible
 * number and a wrong one, so the test asserts that nothing is compared rather than
 * asserting a particular conversion.
 */

const BAND: PayBand = {
  currency: 'GBP',
  minMinor: 5_000_000, // £50,000.00
  midMinor: 6_000_000,
  maxMinor: 7_000_000,
};

describe('bandStanding', () => {
  describe('inside and outside the band', () => {
    it('given pay at the exact minimum, when compared, then it is within the band at position zero', () => {
      const standing = bandStanding({ amountMinor: 5_000_000, currency: 'GBP' }, BAND);

      expect(standing.fit).toBe('WITHIN');
      expect(standing.positionBasisPoints).toBe(0);
      expect(standing.shortfallMinor).toBe(0);
    });

    it('given pay at the exact maximum, when compared, then it is within the band at the top', () => {
      const standing = bandStanding({ amountMinor: 7_000_000, currency: 'GBP' }, BAND);

      expect(standing.fit).toBe('WITHIN');
      expect(standing.positionBasisPoints).toBe(BAND_WIDTH_BASIS_POINTS);
      expect(standing.excessMinor).toBe(0);
    });

    it('given pay one penny below the minimum, when compared, then it is below by one penny', () => {
      const standing = bandStanding({ amountMinor: 4_999_999, currency: 'GBP' }, BAND);

      expect(standing.fit).toBe('BELOW');
      expect(standing.shortfallMinor).toBe(1);
      expect(standing.excessMinor).toBe(0);
    });

    it('given pay one penny above the maximum, when compared, then it is above by one penny', () => {
      const standing = bandStanding({ amountMinor: 7_000_001, currency: 'GBP' }, BAND);

      expect(standing.fit).toBe('ABOVE');
      expect(standing.excessMinor).toBe(1);
      expect(standing.shortfallMinor).toBe(0);
    });

    it('given pay at the midpoint, when compared, then it sits halfway across the band', () => {
      const standing = bandStanding({ amountMinor: 6_000_000, currency: 'GBP' }, BAND);

      expect(standing.positionBasisPoints).toBe(BAND_WIDTH_BASIS_POINTS / 2);
    });

    it('given pay below the band, when compared, then the position is negative rather than clamped', () => {
      /* Not clamped to zero: a marker drawn off the left of the track is the point,
         and a reader who sees every underpaid person pinned to the minimum cannot
         tell "just below" from "half the band below". */
      const standing = bandStanding({ amountMinor: 4_000_000, currency: 'GBP' }, BAND);

      expect(standing.positionBasisPoints).toBe(-5_000);
    });
  });

  describe('what it refuses to answer', () => {
    it('given a salary in another currency, when compared, then nothing is compared and the band is still reported', () => {
      const standing = bandStanding({ amountMinor: 5_000_000, currency: 'USD' }, BAND);

      expect(standing.fit).toBe('OTHER_CURRENCY');
      expect(standing.positionBasisPoints).toBeNull();
      expect(standing.shortfallMinor).toBe(0);
      // Still returned, so a screen can say what the band is and why it went unused.
      expect(standing.band).toBe(BAND);
    });

    it('given no band for the level and country, when compared, then it reports no band', () => {
      const standing = bandStanding({ amountMinor: 5_000_000, currency: 'GBP' }, null);

      expect(standing.fit).toBe('NO_BAND');
      expect(standing.band).toBeNull();
    });

    it('given nobody with a salary recorded, when compared, then it reports no pay', () => {
      const standing = bandStanding(null, BAND);

      expect(standing.fit).toBe('NO_PAY');
      expect(standing.band).toBe(BAND);
    });

    it('given both no band and no pay, when compared, then the missing band is reported first', () => {
      /* A level with no band in a country affects everybody in it; a missing salary
         is about one person. The reference-data gap is the more useful thing to say. */
      expect(bandStanding(null, null).fit).toBe('NO_BAND');
    });
  });

  describe('a band with no width', () => {
    const flat: PayBand = { currency: 'GBP', minMinor: 100, midMinor: 100, maxMinor: 100 };

    it('given a band whose edges are equal and pay on it, when compared, then it is within at position zero', () => {
      const standing = bandStanding({ amountMinor: 100, currency: 'GBP' }, flat);

      expect(standing.fit).toBe('WITHIN');
      expect(standing.positionBasisPoints).toBe(0);
    });

    it('given a band whose edges are equal and pay above it, when compared, then it is above at the top', () => {
      const standing = bandStanding({ amountMinor: 101, currency: 'GBP' }, flat);

      expect(standing.fit).toBe('ABOVE');
      expect(standing.excessMinor).toBe(1);
      expect(standing.positionBasisPoints).toBe(BAND_WIDTH_BASIS_POINTS);
    });
  });
});
