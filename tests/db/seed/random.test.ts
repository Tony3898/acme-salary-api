import { SeededRandom } from '../../../src/db/seed/random';

describe('SeededRandom', () => {
  /** Ten values from one generator. Drawing from a fresh instance each time would
      only ever return the first value, which is what made an earlier version of
      this test unable to detect a broken sequence. */
  const sequenceOf = (seed: number, length = 10) => {
    const random = new SeededRandom(seed);
    return Array.from({ length }, () => random.next());
  };

  it('given the same seed, when values are drawn, then the whole sequence repeats', () => {
    // The reason this exists instead of Math.random.
    const first = sequenceOf(42);

    expect(sequenceOf(42)).toEqual(first);
    // The sequence has to actually advance, or repeating it would prove nothing.
    expect(new Set(first).size).toBe(first.length);
  });

  it('given different seeds, when values are drawn, then the sequences differ', () => {
    expect(sequenceOf(1)).not.toEqual(sequenceOf(2));
  });

  it('given many draws, when checked, then every value is within [0, 1)', () => {
    const random = new SeededRandom(7);

    for (let draw = 0; draw < 1000; draw += 1) {
      const value = random.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('given a range, when integers are drawn, then both ends are inclusive and nothing falls outside', () => {
    const random = new SeededRandom(3);
    const seen = new Set<number>();

    for (let draw = 0; draw < 500; draw += 1) {
      seen.add(random.integer(1, 4));
    }

    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });

  it('given a single-value range, when an integer is drawn, then it is that value', () => {
    expect(new SeededRandom(5).integer(9, 9)).toBe(9);
  });

  it('given an empty list, when picking, then it fails rather than returning undefined', () => {
    /* Without this, an empty reference-data list would silently produce employees
       with undefined departments. */
    expect(() => new SeededRandom(1).pick([])).toThrow(/empty/i);
  });

  it('given a probability, when chance is sampled, then it fires at roughly that rate', () => {
    const random = new SeededRandom(11);
    let hits = 0;

    for (let draw = 0; draw < 2000; draw += 1) {
      if (random.chance(0.25)) hits += 1;
    }

    expect(hits / 2000).toBeGreaterThan(0.2);
    expect(hits / 2000).toBeLessThan(0.3);
  });
});
