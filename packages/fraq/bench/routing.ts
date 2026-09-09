import type { Session } from '../src/routing/command';
import { Router } from '../src/routing/router';
import { Tokenizer } from '../src/routing/tokenizer';

import { performance } from 'node:perf_hooks';

function measure(name: string, run: () => unknown): void {
  for (let i = 0; i < 100; i++) run();
  const samples: number[] = [];
  for (let round = 0; round < 5; round++) {
    let iterations = 0;
    const start = performance.now();
    let elapsed: number;
    do {
      for (let i = 0; i < 10; i++) run();
      iterations += 10;
      elapsed = performance.now() - start;
    } while (elapsed < 150);
    samples.push((elapsed * 1000) / iterations);
  }
  samples.sort((left, right) => left - right);
  console.log(`${name}: ${samples[2].toFixed(3)} us/op`);
}

function measureMatch(name: string, router: Router, text: string): void {
  const raw = { segments: [{ type: 'text', data: { text } }] } as Session['raw'];
  const session: Session = {
    selfId: 1,
    raw,
    async reply() {
      return { messageSeq: 0 };
    },
    async reaction() {},
  };
  measure(name, () => router.match(session, raw));
}

console.log(`Node ${process.version}; median of 5 samples, at least 150 ms/sample`);
for (const count of [10, 100, 1000]) {
  const router = new Router();
  for (let i = 0; i < count; i++) router.command(`cmd${i}`).execute(() => {});
  measureMatch(`${count} routes, last hit`, router, `cmd${count - 1}`);
  measureMatch(`${count} routes, short miss`, router, 'unknown');
  measureMatch(`${count} routes, 4096-char miss`, router, 'x'.repeat(4096));
}

const grouped = new Router();
const nested = grouped.group('admin').group('users');
for (let i = 0; i < 100; i++) nested.command(`cmd${i}`).execute(() => {});
measureMatch('100 grouped routes, last hit', grouped, 'admin users cmd99');

const prefixed = new Router().setActivationResolver(() => [{ type: 'prefix', prefix: '/' }]);
for (let i = 0; i < 100; i++)
  prefixed
    .command(`cmd${i}`)
    .alias(`alias${i}`)
    .execute(() => {});
measureMatch('100 prefixed routes, last alias hit', prefixed, '/alias99');

const textSegments = [{ type: 'text' as const, data: { text: `  ${'hello '.repeat(100)}` } }];
measure('greedy availability + capture', () => {
  const tokenizer = new Tokenizer(textSegments);
  return tokenizer.isGreedyAvailable() && tokenizer.greedy();
});
const mixedSegments = [
  ...textSegments,
  ...Array.from({ length: 100 }, (_, user_id) => ({ type: 'mention' as const, data: { user_id, name: '' } })),
];
measure('catch-all text + 100 mentions', () => new Tokenizer(mixedSegments).catchAll());
measure('catch-all 100 mentions', () => {
  const tokenizer = new Tokenizer(mixedSegments);
  tokenizer.greedy();
  return tokenizer.catchAll();
});
