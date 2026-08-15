/** Small reproducible PRNG; state is private to one simulation run. */
export class SeededRandom {
  private state: number;
  private spareGaussian: number | undefined;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  gaussian(): number {
    if (this.spareGaussian !== undefined) {
      const spare = this.spareGaussian;
      this.spareGaussian = undefined;
      return spare;
    }

    const first = Math.max(Number.EPSILON, this.next());
    const second = this.next();
    const magnitude = Math.sqrt(-2 * Math.log(first));
    const angle = 2 * Math.PI * second;
    this.spareGaussian = magnitude * Math.sin(angle);
    return magnitude * Math.cos(angle);
  }
}
