const PCG32_MULTIPLIER = 6_364_136_223_846_793_005n;
const UINT64_MASK = (1n << 64n) - 1n;
const UINT32_MODULUS = 2 ** 32;

function rotateRight32(value: number, rotation: number): number {
  const amount = rotation & 31;
  if (amount === 0) {
    return value >>> 0;
  }
  return ((value >>> amount) | (value << (32 - amount))) >>> 0;
}

// PCG32, inlined from @fraqjs/plugin-random to keep this plugin dependency-free.
class PCG32 {
  private state: bigint;
  private readonly increment: bigint;

  constructor(seed: bigint, sequence = 1n) {
    this.state = 0n;
    this.increment = ((sequence << 1n) | 1n) & UINT64_MASK;
    this.nextUint32();
    this.state = (this.state + seed) & UINT64_MASK;
    this.nextUint32();
  }

  nextUint32(): number {
    const currentState = this.state;
    this.state = (currentState * PCG32_MULTIPLIER + this.increment) & UINT64_MASK;

    const xorshifted = Number((((currentState >> 18n) ^ currentState) >> 27n) & 0xffff_ffffn);
    const rotation = Number((currentState >> 59n) & 31n);

    return rotateRight32(xorshifted, rotation);
  }
}

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer.`);
  }
}

// Deterministic random covering only what the entity factories need.
export class SeededRandom {
  private readonly generator: PCG32;

  constructor(seed: number) {
    assertSafeInteger(seed, 'seed');
    this.generator = new PCG32(BigInt(seed >>> 0));
  }

  private uint32(): number {
    return this.generator.nextUint32();
  }

  float(): number {
    return this.uint32() / UINT32_MODULUS;
  }

  bool(probability = 0.5): boolean {
    return this.float() < probability;
  }

  int(maxExclusive: number): number;
  int(minInclusive: number, maxExclusive: number): number;
  int(minOrMax: number, maxExclusive?: number): number {
    const minInclusive = maxExclusive === undefined ? 0 : minOrMax;
    const actualMaxExclusive = maxExclusive ?? minOrMax;

    assertSafeInteger(minInclusive, 'minInclusive');
    assertSafeInteger(actualMaxExclusive, 'maxExclusive');
    if (actualMaxExclusive <= minInclusive) {
      throw new RangeError('maxExclusive must be greater than minInclusive.');
    }

    const span = actualMaxExclusive - minInclusive;
    const limit = Math.floor(UINT32_MODULUS / span) * span;
    let value = this.uint32();
    while (value >= limit) {
      value = this.uint32();
    }

    return minInclusive + (value % span);
  }

  range(minInclusive: number, maxInclusive: number): number {
    assertSafeInteger(minInclusive, 'minInclusive');
    assertSafeInteger(maxInclusive, 'maxInclusive');
    if (maxInclusive < minInclusive) {
      throw new RangeError('maxInclusive must be greater than or equal to minInclusive.');
    }

    return minInclusive + this.int(maxInclusive - minInclusive + 1);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError('items must not be empty.');
    }
    return items[this.int(items.length)] as T;
  }

  weightedPick<T>(items: readonly T[], weightOf: (item: T) => number): T {
    if (items.length === 0) {
      throw new RangeError('items must not be empty.');
    }

    let totalWeight = 0;
    for (const item of items) {
      totalWeight += weightOf(item);
    }

    const target = this.float() * totalWeight;
    let cumulative = 0;
    for (const item of items) {
      cumulative += weightOf(item);
      if (target < cumulative) {
        return item;
      }
    }

    return items[items.length - 1] as T;
  }
}
