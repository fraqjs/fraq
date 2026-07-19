import { compileActivationResolver } from '../src/app/activation';
import { buildStartScript } from '../src/app/start-script';
import type { Config } from '../src/config';

import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

test('builds recursive fork filters into the generated start script', () => {
  const config: Config = {
    configVersion: 1,
    fraqVersion: '0.13.0',
    milky: {
      url: 'http://localhost:3000',
      connectEvent: true,
    },
    logging: {
      minLevel: 'info',
    },
    versions: {},
    forks: {
      audience: {
        filter: {
          and: [
            { or: [{ groups: [123456, 987654] }, { friends: [456789] }, 'allFriends', 'allGroups', 'allPass'] },
            { not: 'admin' },
          ],
        },
        forks: {
          unfiltered: {},
        },
      },
    },
  };

  const script = buildStartScript(config);

  assert.ok(script.includes("import { Context, filter } from '@fraqjs/fraq';"));
  assert.ok(
    script.includes(
      'const context1 = ctx.fork("audience", filter.and(filter.or(filter.group(123456, 987654), filter.friend(456789), filter.allFriends(), filter.allGroups(), filter.allPass()), filter.not(filter.admin())));',
    ),
  );
  assert.ok(script.includes('const context2 = context1.fork("unfiltered");'));
  assert.doesNotMatch(script, /activationResolver/);
  assert.match(script, /routing: undefined/);
});

test('compiles activation overrides into a route resolver', () => {
  const resolver = runInNewContext(
    `(${compileActivationResolver({
      default: [{ type: 'direct' }],
      overrides: [
        {
          match: {
            plugin: ['help', 'admin'],
            context: ['root'],
            tag: ['protected', 'moderated'],
            command: ['ban', 'kick'],
          },
          rule: [{ type: 'mention', prefix: '/' }],
        },
        {
          match: { plugin: ['help'] },
          rule: [{ type: 'prefix', prefix: '/' }],
        },
      ],
    })})`,
  ) as (route: object) => unknown;
  const resolve = (route: object) => JSON.parse(JSON.stringify(resolver(route)));

  const matchingRoute = {
    type: 'command',
    name: 'ban',
    meta: { plugin: 'help', context: 'root', tags: ['protected'] },
  };
  assert.deepEqual(resolve(matchingRoute), [{ type: 'mention', prefix: '/' }]);
  assert.deepEqual(resolve({ type: 'command', name: 'ping', meta: { plugin: 'help' } }), [
    { type: 'prefix', prefix: '/' },
  ]);
  assert.deepEqual(
    resolve({ type: 'command', name: 'ban', meta: { plugin: 'help', context: 'other', tags: ['protected'] } }),
    [{ type: 'prefix', prefix: '/' }],
  );
  assert.deepEqual(resolve({ type: 'rawPattern', path: [], meta: { plugin: 'other' } }), [{ type: 'direct' }]);
});

test('uses direct activation when the config omits a default rule', () => {
  const resolver = runInNewContext(`(${compileActivationResolver({})})`) as (route: object) => unknown;

  assert.equal(JSON.stringify(resolver({ type: 'command', name: 'ping' })), '[{"type":"direct"}]');
});

test('passes the compiled activation resolver to Context initialization', () => {
  const config: Config = {
    configVersion: 1,
    fraqVersion: '0.13.0',
    milky: {
      url: 'http://localhost:3000',
      connectEvent: true,
    },
    logging: {
      minLevel: 'info',
    },
    versions: {},
    activation: {
      default: [{ type: 'mention' }],
    },
  };

  const script = buildStartScript(config);

  assert.ok(script.startsWith('#!/usr/bin/env node'));
  assert.match(script, /const activationResolver = \(route\) => \{/);
  assert.match(script, /routing: \{ activationResolver \}/);
  assert.match(script, /return \[\{"type":"mention"\}\];/);
});
