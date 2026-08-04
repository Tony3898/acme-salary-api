import { isValidIsoDate, toIsoDate } from '../../src/domain/dates';

describe('toIsoDate', () => {
  it('given an instant, when converted, then it is the UTC calendar date', () => {
    expect(toIsoDate(new Date('2026-08-04T09:30:00.000Z'))).toBe('2026-08-04');
  });

  it('given an instant late in the UTC day, when converted, then the date does not roll forward', () => {
    /* The server's own time zone must not decide what day it is. Read as local
       time east of UTC, this instant is already the 5th. */
    expect(toIsoDate(new Date('2026-08-04T23:59:59.000Z'))).toBe('2026-08-04');
  });
});

describe('isValidIsoDate', () => {
  it.each(['2026-08-04', '2024-02-29', '2000-01-01'])(
    'given %s, when checked, then it is a date',
    (value) => {
      expect(isValidIsoDate(value)).toBe(true);
    },
  );

  it.each([
    ['a day that does not exist', '2026-02-31'],
    ['a day that does not exist in a common year', '2025-02-29'],
    ['month thirteen', '2026-13-01'],
    ['day zero', '2026-08-00'],
    ['a different format', '04/08/2026'],
    ['a timestamp', '2026-08-04T09:00:00Z'],
    ['nothing', ''],
    ['prose', 'yesterday'],
    ['a short year', '26-08-04'],
  ])('given %s, when checked, then it is refused', (_label, value) => {
    /* The shape check alone is not enough: 2026-02-31 matches the pattern, and
       JavaScript would quietly read it as the 3rd of March. */
    expect(isValidIsoDate(value)).toBe(false);
  });
});
