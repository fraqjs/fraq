import { compileActivationResolver } from '../src/app/activation';
import type { Config } from '../src/config';
import { runGeneratedApp } from './generated-app';

import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

test('generated forks preserve recursive filtering and parent scope', async (t) => {
  const config: Config = {
    configVersion: 1,
    fraqVersion: '0.13.0',
    milky: { url: 'http://localhost:3000', connectEvent: true },
    logging: { minLevel: 'info' },
    versions: {},
    forks: {
      audience: {
        filter: { and: [{ or: [{ groups: [123456, 987654] }, { friends: [456789] }] }, { not: 'admin' }] },
        forks: { unfiltered: {} },
      },
      friends: { filter: 'allFriends' },
      groups: { filter: 'allGroups' },
      everyone: { filter: 'allPass' },
    },
  };
  const events = [
    ['group', 123456, 'member'],
    ['group', 987654, 'member'],
    ['group', 123456, 'admin'],
    ['group', 111111, 'member'],
    ['friend', 456789, 'member'],
    ['friend', 111111, 'member'],
  ].map(([scene, peer, role]) => ({
    event_type: 'message_receive',
    data: { message_scene: scene, peer_id: peer, group_member: { role } },
  }));
  const result = await runGeneratedApp(t, config, { events, routes: [{ type: 'command', name: 'ping' }] });
  const scopes = new Map(result.contexts.map((scope) => [scope.path.join('/'), scope.accepts]));
  assert.deepEqual(scopes.get('root/audience'), [true, true, false, false, true, false]);
  assert.deepEqual(scopes.get('root/audience/unfiltered'), scopes.get('root/audience'));
  assert.deepEqual(scopes.get('root/friends'), [false, false, false, false, true, true]);
  assert.deepEqual(scopes.get('root/groups'), [true, true, true, true, false, false]);
  assert.deepEqual(
    scopes.get('root/everyone'),
    events.map(() => true),
  );
  assert.deepEqual(result.activations, [null]);
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

test('generated startup passes a working activation resolver to Context', async (t) => {
  const config: Config = {
    configVersion: 1,
    fraqVersion: '0.13.0',
    milky: { url: 'http://localhost:3000', connectEvent: true },
    logging: { minLevel: 'info' },
    versions: {},
    activation: {
      default: [{ type: 'mention' }],
      overrides: [{ match: { command: ['help'] }, rule: [{ type: 'prefix', prefix: '/' }] }],
    },
  };
  const result = await runGeneratedApp(t, config, {
    routes: [
      { type: 'command', name: 'ping' },
      { type: 'command', name: 'help' },
    ],
  });
  assert.deepEqual(result.activations, [[{ type: 'mention' }], [{ type: 'prefix', prefix: '/' }]]);
});
