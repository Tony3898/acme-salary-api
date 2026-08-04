/**
 * A small seeded generator, so the same seed always produces the same data.
 *
 * Math.random cannot do this, and reproducibility is not cosmetic here: other
 * tests assert on seeded values, and a demo that reshuffles on every run is
 * impossible to talk through. mulberry32 is a few lines and adequate for
 * generating sample data — it is not used for anything security-related.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    // Any non-zero start works; the offset just avoids a degenerate first value.
    this.state = (seed | 0) + 0x6d2b79f5;
  }

  /** Float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** Integer in [min, max], both inclusive. */
  integer(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.integer(0, items.length - 1)];
    if (item === undefined) {
      throw new Error('Cannot pick from an empty list.');
    }
    return item;
  }

  /** True with the given probability, expressed as a fraction of 1. */
  chance(probability: number): boolean {
    return this.next() < probability;
  }
}
