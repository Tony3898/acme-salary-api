import {
  changeBetween,
  currentRecordIndex,
  withChanges,
  type PayPoint,
} from '../../src/domain/compensation';

/**
 * Reading a pay history as a sequence of changes.
 *
 * Pure arithmetic, and the cases that matter are the ones where the arithmetic
 * should refuse to produce a number at all.
 */
describe('changeBetween', () => {
  const point = (
    amountMinor: number,
    currency = 'USD',
    effectiveFrom = '2024-01-01',
  ): PayPoint => ({
    amountMinor,
    currency,
    effectiveFrom,
  });

  it('given a raise, when compared, then the amount and the percentage are both given', () => {
    expect(changeBetween(point(8_000_000), point(9_000_000))).toEqual({
      amountMinor: 1_000_000,
      percentage: 12.5,
      reason: null,
    });
  });

  it('given a cut, when compared, then both are negative', () => {
    expect(changeBetween(point(10_000_000), point(9_000_000))).toEqual({
      amountMinor: -1_000_000,
      percentage: -10,
      reason: null,
    });
  });

  it('given the first record, when compared, then there is no change to report', () => {
    /* A starting salary is not a raise from zero. Reporting it as an infinite
       increase would be worse than reporting nothing. */
    expect(changeBetween(null, point(8_000_000))).toEqual({
      amountMinor: null,
      percentage: null,
      reason: 'FIRST_RECORD',
    });
  });

  it('given the currency changed, when compared, then no comparison is made', () => {
    /* Relocating from London to Bangalore takes somebody from 120,000 to
       5,000,000. That is not a 4,000% raise, and converting both to USD would
       produce a number about exchange rates rather than about their pay. */
    expect(changeBetween(point(12_000_000, 'GBP'), point(500_000_000, 'INR'))).toEqual({
      amountMinor: null,
      percentage: null,
      reason: 'CURRENCY_CHANGED',
    });
  });

  it('given an awkward ratio, when compared, then the percentage is rounded rather than exact', () => {
    // 1/3 is 33.333…%, and nobody needs a raise reported to eight decimal places.
    expect(changeBetween(point(3_000_000), point(4_000_000)).percentage).toBe(33.33);
  });

  it('given no change at all, when compared, then it reads as zero rather than as nothing', () => {
    /* A correction that restores the same figure is a real event. Zero and "no
       comparison possible" are different answers and must look different. */
    expect(changeBetween(point(8_000_000), point(8_000_000))).toEqual({
      amountMinor: 0,
      percentage: 0,
      reason: null,
    });
  });
});

describe('withChanges', () => {
  it('given a history, when annotated, then each change is from the record before it', () => {
    const history: PayPoint[] = [
      { amountMinor: 7_500_000, currency: 'USD', effectiveFrom: '2022-01-01' },
      { amountMinor: 8_200_000, currency: 'USD', effectiveFrom: '2023-04-01' },
      { amountMinor: 9_000_000, currency: 'USD', effectiveFrom: '2025-04-01' },
    ];

    const annotated = withChanges(history);

    expect(annotated.map((entry) => entry.change.amountMinor)).toEqual([null, 700_000, 800_000]);
    expect(annotated[0]?.change.reason).toBe('FIRST_RECORD');
  });

  it('given no history, when annotated, then nothing comes back and nothing throws', () => {
    expect(withChanges([])).toEqual([]);
  });

  it('given one record, when annotated, then it is the first and has no change', () => {
    const only: PayPoint[] = [
      { amountMinor: 5_000_000, currency: 'USD', effectiveFrom: '2024-01-01' },
    ];
    expect(withChanges(only)[0]?.change.reason).toBe('FIRST_RECORD');
  });
});

describe('currentRecordIndex', () => {
  const history: PayPoint[] = [
    { amountMinor: 7_500_000, currency: 'USD', effectiveFrom: '2022-01-01' },
    { amountMinor: 8_200_000, currency: 'USD', effectiveFrom: '2023-04-01' },
    // Signed off, not yet started.
    { amountMinor: 9_000_000, currency: 'USD', effectiveFrom: '2026-12-01' },
  ];

  it('given a date, when asked, then the latest record that has started is in force', () => {
    expect(currentRecordIndex(history, '2026-08-04')).toBe(1);
  });

  it('given a raise starting today, when asked, then today counts', () => {
    // The boundary the whole feature turns on: a raise starts on its start date.
    expect(currentRecordIndex(history, '2023-04-01')).toBe(1);
    expect(currentRecordIndex(history, '2023-03-31')).toBe(0);
  });

  it('given a date before anybody was paid, when asked, then no record is in force', () => {
    expect(currentRecordIndex(history, '2020-01-01')).toBeNull();
  });

  it('given two records on the same day, when asked, then the later one wins', () => {
    /* The same rule the SQL uses to break a same-day tie. A correction issued
       the same day is legitimate, and both places must agree which one counts. */
    const sameDay: PayPoint[] = [
      { amountMinor: 8_000_000, currency: 'USD', effectiveFrom: '2024-01-01' },
      { amountMinor: 8_500_000, currency: 'USD', effectiveFrom: '2024-01-01' },
    ];

    expect(currentRecordIndex(sameDay, '2024-06-01')).toBe(1);
  });

  it('given no history at all, when asked, then there is no record in force', () => {
    expect(currentRecordIndex([], '2026-08-04')).toBeNull();
  });
});
