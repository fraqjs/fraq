import { RandomService } from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

test('same seed produces the same uint32 sequence', () => {
  const first = new RandomService({ seed: 42 });
  const second = new RandomService({ seed: 42 });

  assert.deepEqual(
    [first.uint32(), first.uint32(), first.uint32()],
    [second.uint32(), second.uint32(), second.uint32()],
  );
});

test('float maps uint32 boundaries into the half-open unit interval', (t) => {
  const random = new RandomService({ seed: 123 });
  for (const [word, expected] of [
    [0, 0],
    [2 ** 31, 0.5],
    [2 ** 32 - 1, 1 - 2 ** -32],
  ]) {
    const draw = t.mock.method(random, 'uint32', () => word);
    assert.equal(random.float(), expected);
    draw.mock.restore();
  }
});

test('bool respects edge probabilities', () => {
  const random = new RandomService({ seed: 456 });

  assert.equal(random.bool(0), false);
  assert.equal(random.bool(1), true);
});

test('int respects integer boundaries and rejects the biased uint32 tail', (t) => {
  const random = new RandomService({ seed: 789 });
  const words = [0, 9, 2 ** 32 - 1, 4, 0, 4, 2 ** 32 - 1];
  t.mock.method(random, 'uint32', () => {
    const word = words.shift();
    assert.ok(word !== undefined, 'sampling must make progress');
    return word;
  });
  assert.equal(random.int(10), 0);
  assert.equal(random.int(10), 9);
  assert.equal(random.int(10), 4);
  assert.equal(random.int(3, 8), 3);
  assert.equal(random.int(3, 8), 7);
  assert.equal(random.int(2 ** 32), 2 ** 32 - 1);
  assert.equal(words.length, 0);
});

test('range includes both endpoints without depending on a seed hitting them', (t) => {
  const random = new RandomService({ seed: 1357 });
  let upper = false;
  t.mock.method(random, 'int', (minOrMax: number, max?: number) =>
    upper ? (max ?? minOrMax) - 1 : max === undefined ? 0 : minOrMax,
  );
  assert.equal(random.range(3, 8), 3);
  upper = true;
  assert.equal(random.range(3, 8), 8);
  assert.equal(random.range(5, 5), 5);
});

test('pick uses the sampled index including the first and last item', (t) => {
  const random = new RandomService({ seed: 2468 });
  const items = ['alpha', 'beta', 'gamma'] as const;
  for (let index = 0; index < items.length; index++) {
    const draw = t.mock.method(random, 'int', () => index);
    assert.equal(random.pick(items), items[index]);
    draw.mock.restore();
  }
});

test('shuffle uses random choices and preserves the input and its elements', (t) => {
  const items = Object.freeze([1, 2, 3, 4, 5]);
  const first = new RandomService({ seed: 999 });
  const second = new RandomService({ seed: 999 });
  assert.deepEqual(first.shuffle(items), second.shuffle(items));

  t.mock.method(first, 'int', (minOrMax: number, max?: number) => (max === undefined ? 0 : minOrMax));
  t.mock.method(second, 'int', (minOrMax: number, max?: number) => (max ?? minOrMax) - 1);
  const lowerChoices = first.shuffle(items);
  const upperChoices = second.shuffle(items);
  assert.notDeepEqual(lowerChoices, upperChoices, 'different random choices must influence the permutation');
  for (const result of [lowerChoices, upperChoices]) {
    assert.notEqual(result, items);
    assert.deepEqual(
      [...result].sort((a, b) => a - b),
      [...items],
    );
  }
  assert.deepEqual(items, [1, 2, 3, 4, 5]);
});

test('sample uses random choices without replacement or input mutation', (t) => {
  const items = Object.freeze(['a', 'b', 'c', 'd', 'e']);
  const first = new RandomService({ seed: 2025 });
  const second = new RandomService({ seed: 2025 });
  assert.deepEqual(first.sample(items, 3), second.sample(items, 3));
  t.mock.method(first, 'int', (minOrMax: number, max?: number) => (max === undefined ? 0 : minOrMax));
  t.mock.method(second, 'int', (minOrMax: number, max?: number) => (max ?? minOrMax) - 1);
  const lowerChoices = first.sample(items, 3);
  const upperChoices = second.sample(items, 3);
  assert.notDeepEqual(new Set(lowerChoices), new Set(upperChoices));
  for (const result of [lowerChoices, upperChoices]) {
    assert.equal(result.length, 3);
    assert.equal(new Set(result).size, 3);
    assert.ok(result.every((item) => items.includes(item)));
  }
  assert.deepEqual(first.sample(items, 0), []);
  assert.deepEqual(new Set(second.sample(items, items.length)), new Set(items));
  assert.deepEqual(items, ['a', 'b', 'c', 'd', 'e']);
});

test('weightedIndex follows cumulative weight boundaries and skips zero weights', (t) => {
  const random = new RandomService({ seed: 8080 });
  for (const [draw, expected] of [
    [0, 1],
    [0.25 - Number.EPSILON, 1],
    [0.25, 3],
    [1 - Number.EPSILON, 3],
  ]) {
    const source = t.mock.method(random, 'float', () => draw);
    assert.equal(random.weightedIndex([0, 1, 0, 3, 0]), expected);
    source.mock.restore();
  }
});

test('weightedPick uses item weights rather than always selecting a positive item', (t) => {
  const random = new RandomService({ seed: 9090 });
  const items = [
    { label: 'alpha', weight: 0 },
    { label: 'beta', weight: 2 },
    { label: 'gamma', weight: 0 },
    { label: 'delta', weight: 5 },
  ];
  for (const [draw, label] of [
    [0, 'beta'],
    [0.5, 'delta'],
    [1 - Number.EPSILON, 'delta'],
  ] as const) {
    const source = t.mock.method(random, 'float', () => draw);
    assert.equal(random.weightedPick(items, (item) => item.weight).label, label);
    source.mock.restore();
  }
  assert.equal(random.weightedPick(items, (item) => (item.label === 'alpha' ? 1 : 0)).label, 'alpha');
});

test('clone preserves the current generator state', () => {
  const original = new RandomService({ seed: 314159 });

  original.uint32();
  original.uint32();

  const clone = original.clone();

  assert.deepEqual(
    [original.uint32(), original.uint32(), original.uint32()],
    [clone.uint32(), clone.uint32(), clone.uint32()],
  );
});

test('fromState resumes the exported generator state', () => {
  const original = new RandomService({ seed: 4242, sequence: 7 });

  original.uint32();
  original.uint32();

  const restored = RandomService.fromState(original.exportState());

  assert.deepEqual(
    [original.uint32(), original.uint32(), original.uint32()],
    [restored.uint32(), restored.uint32(), restored.uint32()],
  );
});

test('rejects non-safe integer seeds and sequences', () => {
  assert.throws(() => new RandomService({ seed: Number.NaN }), /seed/);
  assert.throws(() => new RandomService({ sequence: 1.5 }), /sequence/);
});

test('rejects invalid business api arguments', () => {
  const random = new RandomService();

  assert.throws(() => random.bool(-0.1), /probability/);
  assert.throws(() => random.int(0), /maxExclusive/);
  assert.throws(() => random.int(5, 5), /maxExclusive/);
  assert.throws(() => random.range(3, 2), /maxInclusive/);
  assert.throws(() => random.pick([]), /items/);
  assert.throws(() => random.sample([1, 2], -1), /count/);
  assert.throws(() => random.sample([1, 2], 3), /count/);
  assert.throws(() => random.weightedIndex([]), /items/);
  assert.throws(() => random.weightedIndex([0, 0]), /positive/);
  assert.throws(() => random.weightedIndex([1, -1]), /weights\[1\]/);
  assert.throws(() => random.weightedPick([], () => 1), /items/);
  assert.throws(() => random.weightedPick([1, 2], () => Number.NaN), /weightOf/);
});
