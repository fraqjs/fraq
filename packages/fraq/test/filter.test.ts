import { type EventMap, filter } from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

const event: EventMap['bot_offline'] = {
  event_type: 'bot_offline',
  time: 1,
  self_id: 1,
  data: { reason: 'test' },
};

test('filter combinations preserve empty-input and missing-predicate behavior', () => {
  const accept = filter.define({ bot_offline: () => true });

  assert.equal(filter.or().bot_offline?.(event), false);
  assert.equal(filter.and().bot_offline?.(event), true);
  assert.equal(filter.or({}).bot_offline?.(event), false);
  assert.equal(filter.and({}).bot_offline?.(event), false);
  assert.equal(filter.or({}, accept).bot_offline?.(event), true);
  assert.equal(filter.and(accept, {}).bot_offline?.(event), false);
  assert.equal(filter.and(accept, accept).bot_offline?.(event), true);
});

test('filter combinations evaluate in order and short-circuit', () => {
  const calls: string[] = [];
  const accept = filter.define({
    bot_offline(received) {
      assert.equal(received, event);
      calls.push('accept');
      return true;
    },
  });
  const reject = filter.define({
    bot_offline() {
      calls.push('reject');
      return false;
    },
  });

  assert.equal(filter.or(reject, accept, reject).bot_offline?.(event), true);
  assert.deepEqual(calls, ['reject', 'accept']);
  calls.length = 0;
  assert.equal(filter.and(accept, reject, accept).bot_offline?.(event), false);
  assert.deepEqual(calls, ['accept', 'reject']);
});

test('filter combinations call predicates without binding the filter as this', () => {
  const accept = filter.define({
    bot_offline(this: unknown) {
      assert.equal(this, undefined);
      return true;
    },
  });

  assert.equal(filter.or(accept).bot_offline?.(event), true);
  assert.equal(filter.and(accept).bot_offline?.(event), true);
});
