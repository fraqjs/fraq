import { createMockInbox, inmsg, inseg } from '@fraqjs/mock';

import { type milky, param, type RouteDescriptor, Router, type Session } from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

const inbox = createMockInbox();

function session(raw: milky.IncomingMessage): Session {
  return {
    selfId: 10001,
    raw,
    async reply() {
      return { messageSeq: 0 };
    },
    async reaction() {},
  };
}

function message(segments: readonly milky.IncomingSegment_ZodInput[] | readonly milky.IncomingSegment[]) {
  return inbox.friend({ userId: 1 }, segments);
}

async function dispatch(
  router: Router,
  segments: readonly milky.IncomingSegment_ZodInput[] | readonly milky.IncomingSegment[],
): Promise<boolean> {
  const raw = message(segments);
  return await router.dispatch(session(raw), raw);
}

test('dispatches a command and captures typed parameters', async () => {
  const router = new Router();
  const calls: Array<{ count: number; label: string }> = [];

  router.command({
    name: 'add',
    pattern: { count: param.num(), label: param.str() },
    execute(_session, params) {
      calls.push(params);
    },
  });

  const handled = await dispatch(router, inmsg`add 3 apples`);

  assert.equal(handled, true);
  assert.deepEqual(calls, [{ count: 3, label: 'apples' }]);
});

test('dispatches a command separated by supported whitespace characters', async () => {
  const whitespaceChars = [' ', '\t', '\n', '\r', '\v', '\f', '\u00A0', '\u3000'];

  for (const whitespace of whitespaceChars) {
    const router = new Router();
    const calls: Array<{ count: number; label: string }> = [];

    router.command({
      name: 'add',
      pattern: { count: param.num(), label: param.str() },
      execute(_session, params) {
        calls.push(params);
      },
    });

    const handled = await dispatch(router, [inseg.text(`add${whitespace}3${whitespace}apples`)]);

    assert.equal(handled, true);
    assert.deepEqual(calls, [{ count: 3, label: 'apples' }]);
  }
});

test('dispatches a command registered with the builder syntax', async () => {
  const router = new Router();
  let captured: { count: number; label: string } | undefined;

  const command = router
    .command('add')
    .arg('count', param.num())
    .arg('label', param.str())
    .execute((_session, params) => {
      captured = params;
    });

  const handled = await dispatch(router, inmsg`add 3 apples`);

  assert.equal(command.name, 'add');
  assert.deepEqual(Object.keys(command.pattern), ['count', 'label']);
  assert.equal(handled, true);
  assert.deepEqual(captured, { count: 3, label: 'apples' });
});

test('does not dispatch a command when trailing tokens remain', async () => {
  const router = new Router();
  let called = false;

  router.command({
    name: 'ping',
    pattern: {},
    execute() {
      called = true;
    },
  });

  const handled = await dispatch(router, inmsg`ping extra`);

  assert.equal(handled, false);
  assert.equal(called, false);
});

test('greedy command parameter captures the remaining text', async () => {
  const router = new Router();
  let captured = '';

  router.command({
    name: 'say',
    pattern: { content: param.greedy() },
    execute(_session, params) {
      captured = params.content;
    },
  });

  const handled = await dispatch(router, inmsg`say hello   world`);

  assert.equal(handled, true);
  assert.equal(captured, 'hello   world');
});

test('tries later routes after a command pattern fails', async () => {
  const router = new Router();
  const calls: string[] = [];

  router.command({
    name: 'pick',
    pattern: { value: param.num() },
    execute() {
      calls.push('number');
    },
  });
  router.command({
    name: 'pick',
    pattern: { value: param.str() },
    execute(_session, params) {
      calls.push(params.value);
    },
  });

  const handled = await dispatch(router, inmsg`pick blue`);

  assert.equal(handled, true);
  assert.deepEqual(calls, ['blue']);
});

test('does not evaluate later filters after an earlier route matches', async () => {
  const router = new Router();
  let checkedLaterFilter = false;

  router.command({
    name: 'ping',
    pattern: {},
    execute() {},
  });
  router
    .filter(() => {
      checkedLaterFilter = true;
      return true;
    })
    .command('secret')
    .execute(() => {});

  assert.equal(await dispatch(router, inmsg`ping`), true);
  assert.equal(checkedLaterFilter, false);
});

test('dispatches grouped commands after matching the group prefix', async () => {
  const router = new Router();
  let captured = 0;

  router.group('admin').command({
    name: 'ban',
    pattern: { userId: param.num() },
    execute(_session, params) {
      captured = params.userId;
    },
  });

  const handled = await dispatch(router, inmsg`admin ban 42`);

  assert.equal(handled, true);
  assert.equal(captured, 42);
});

test('dispatches commands only after mentioning the current bot when mention activation is required', async () => {
  const router = new Router();
  let called = 0;

  router.setActivationResolver(() => ({ type: 'mention' }));
  router.command({
    name: 'ping',
    pattern: {},
    execute() {
      called += 1;
    },
  });

  assert.equal(await dispatch(router, [inseg.mention(10001, 'bot'), inseg.text(' ping')]), true);
  assert.equal(await dispatch(router, [inseg.mention(42, 'alice'), inseg.text(' ping')]), false);
  assert.equal(await dispatch(router, inmsg`ping`), false);
  assert.equal(called, 1);
});

test('dispatches commands only after mentioning the current bot and consuming a prefix', async () => {
  const router = new Router();
  let called = 0;

  router.setActivationResolver(() => ({ type: 'mention', prefix: '/' }));
  router.command('ping').execute(() => {
    called += 1;
  });

  assert.equal(await dispatch(router, [inseg.mention(10001, 'bot'), inseg.text(' /ping')]), true);
  assert.equal(await dispatch(router, [inseg.mention(10001, 'bot'), inseg.text(' ping')]), false);
  assert.equal(await dispatch(router, inmsg`/ping`), false);
  assert.equal(await dispatch(router, [inseg.mention(42, 'alice'), inseg.text(' /ping')]), false);
  assert.equal(called, 1);
});

test('dispatches commands after consuming a configured text prefix', async () => {
  const router = new Router();
  const calls: string[] = [];

  router.setActivationResolver(() => [
    { type: 'prefix', prefix: '/' },
    { type: 'prefix', prefix: '!' },
  ]);
  router.command({
    name: 'say',
    pattern: { content: param.greedy() },
    execute(_session, params) {
      calls.push(params.content);
    },
  });

  assert.equal(await dispatch(router, inmsg`/say hello`), true);
  assert.equal(await dispatch(router, inmsg`/ say spaced`), true);
  assert.equal(await dispatch(router, inmsg`!say loud`), true);
  assert.equal(await dispatch(router, inmsg`say ignored`), false);
  assert.deepEqual(calls, ['hello', 'spaced', 'loud']);
});

test('does not dispatch routes when the activation resolver returns no activations', async () => {
  const router = new Router();
  let called = false;

  router.setActivationResolver(() => []);
  router.command({
    name: 'ping',
    pattern: {},
    execute() {
      called = true;
    },
  });

  assert.equal(await dispatch(router, inmsg`ping`), false);
  assert.equal(called, false);
});

test('dispatches grouped commands with activation before the full route path', async () => {
  const router = new Router();
  const calls: number[] = [];

  router.setActivationResolver(() => [
    { type: 'mention' },
    { type: 'prefix', prefix: '/' },
    { type: 'mention', prefix: '/' },
  ]);
  router
    .group('admin')
    .command('ban')
    .arg('userId', param.num())
    .execute((_session, { userId }) => {
      calls.push(userId);
    });

  assert.equal(await dispatch(router, [inseg.mention(10001, 'bot'), inseg.text(' admin ban 42')]), true);
  assert.equal(await dispatch(router, inmsg`/admin ban 7`), true);
  assert.equal(await dispatch(router, [inseg.mention(10001, 'bot'), inseg.text(' /admin ban 9')]), true);
  assert.equal(await dispatch(router, inmsg`admin ban 1`), false);
  assert.deepEqual(calls, [42, 7, 9]);
});

test('activation resolver settings are entry-local and not inherited by group routers', async () => {
  const root = new Router();
  const admin = root.group('admin');
  const calls: string[] = [];

  root.setActivationResolver(() => [{ type: 'mention' }]);
  admin.setActivationResolver(() => [{ type: 'prefix', prefix: '/' }]);
  admin.command({
    name: 'ping',
    pattern: {},
    execute() {
      calls.push('ping');
    },
  });

  assert.equal(await dispatch(root, [inseg.mention(10001, 'bot'), inseg.text(' admin ping')]), true);
  assert.equal(await dispatch(root, inmsg`/admin ping`), false);
  assert.equal(await dispatch(root, inmsg`admin ping`), false);
  assert.equal(await dispatch(admin, inmsg`/ping`), true);
  assert.equal(await dispatch(admin, [inseg.mention(10001, 'bot'), inseg.text(' ping')]), false);
  assert.deepEqual(calls, ['ping', 'ping']);
});

test('dispatches builder commands under groups and filters', async () => {
  const router = new Router();
  const calls: number[] = [];

  router
    .group('admin')
    .command('ban')
    .arg('userId', param.num())
    .execute((_session, { userId }) => {
      calls.push(userId);
    });
  router
    .filter((session) => session.raw.sender_id === 7)
    .command('secret')
    .execute((session) => {
      calls.push(session.raw.sender_id);
    });

  const rejected = message(inmsg`secret`);
  const accepted = { ...rejected, sender_id: 7 };

  assert.equal(await dispatch(router, inmsg`admin ban 42`), true);
  assert.equal(await router.dispatch(session(rejected), rejected), false);
  assert.equal(await router.dispatch(session(accepted), accepted), true);
  assert.deepEqual(calls, [42, 7]);
});

test('matches the first dispatchable branch without running its handler', () => {
  const router = new Router();
  const calls: string[] = [];

  router.command({
    name: 'pick',
    pattern: { value: param.num() },
    execute() {
      calls.push('number');
    },
  });
  router.command({
    name: 'pick',
    pattern: { value: param.str() },
    execute() {
      calls.push('string');
    },
  });

  const raw = message(inmsg`pick blue`);
  const match = router.match(session(raw), raw);

  assert.equal(match?.type, 'command');
  assert.equal(match.command.name, 'pick');
  assert.deepEqual(match.path, []);
  assert.deepEqual(match.params, { value: 'blue' });
  assert.deepEqual(calls, []);
});

test('matches grouped branches with their group path', () => {
  const router = new Router();

  router.group('admin').command({
    name: 'ban',
    pattern: { userId: param.num() },
    execute() {},
  });

  const raw = message(inmsg`admin ban 42`);
  const match = router.match(session(raw), raw);

  assert.equal(match?.type, 'command');
  assert.equal(match.command.name, 'ban');
  assert.deepEqual(match.path, ['admin']);
  assert.deepEqual(match.params, { userId: 42 });
});

test('returns the same router for repeated group names', () => {
  const router = new Router();

  assert.equal(router.group('admin'), router.group('admin'));
});

test('runs filtered routes only when the predicate accepts the session', async () => {
  const router = new Router();
  const calls: string[] = [];

  router
    .filter((session) => session.raw.sender_id === 7)
    .command({
      name: 'secret',
      pattern: {},
      execute() {
        calls.push('secret');
      },
    });

  const rejected = message(inmsg`secret`);
  const accepted = { ...rejected, sender_id: 7 };

  assert.equal(await router.dispatch(session(rejected), rejected), false);
  assert.equal(await router.dispatch(session(accepted), accepted), true);
  assert.deepEqual(calls, ['secret']);
});

test('lists branches that can pass session filters', () => {
  const router = new Router();

  router.command({ name: 'ping', pattern: {}, execute() {} });
  router.group('admin').command({ name: 'ban', pattern: { userId: param.num() }, execute() {} });
  router.filter((session) => session.raw.sender_id === 7).command({ name: 'secret', pattern: {}, execute() {} });
  router
    .filter((session) => session.raw.sender_id === 8)
    .rawPattern({ pattern: { content: param.greedy() }, execute() {} });

  const raw = message(inmsg`anything`);
  const branches = router.branches(session({ ...raw, sender_id: 7 }));

  assert.deepEqual(
    branches.map((branch) => {
      if (branch.type === 'command') {
        return { type: branch.type, path: branch.path, name: branch.command.name };
      }
      return { type: branch.type, path: branch.path };
    }),
    [
      { type: 'command', path: [], name: 'ping' },
      { type: 'command', path: ['admin'], name: 'ban' },
      { type: 'command', path: [], name: 'secret' },
    ],
  );
});

test('route metadata is available to activation resolvers', async () => {
  const router = new Router();
  const descriptors: RouteDescriptor[] = [];
  let called = false;

  router.setActivationResolver((route) => {
    descriptors.push(route);
    return route.meta?.plugin === 'alpha' && route.meta.tags?.includes('ops')
      ? [{ type: 'prefix', prefix: '/' }]
      : [{ type: 'direct' }];
  });
  router
    .withMeta({ plugin: 'alpha' })
    .group('admin')
    .command('ping')
    .tag('ops')
    .execute(() => {
      called = true;
    });

  assert.equal(await dispatch(router, inmsg`admin ping`), false);
  assert.equal(await dispatch(router, inmsg`/admin ping`), true);
  assert.equal(called, true);
  assert.deepEqual(descriptors.at(-1), {
    type: 'command',
    path: ['admin'],
    name: 'ping',
    meta: { plugin: 'alpha', tags: ['ops'] },
  });
});

test('dispatches raw patterns without a command prefix', async () => {
  const router = new Router();
  let captured = '';

  router.rawPattern({
    pattern: { content: param.greedy() },
    execute(_session, params) {
      captured = params.content;
    },
  });

  const handled = await dispatch(router, inmsg`anything goes here`);

  assert.equal(handled, true);
  assert.equal(captured, 'anything goes here');
});

test('raw patterns without literals ignore activation policies', async () => {
  const router = new Router();
  let captured = '';
  let resolverCalled = false;

  router.setActivationResolver(() => {
    resolverCalled = true;
    return [];
  });
  router.rawPattern({
    pattern: { content: param.greedy() },
    execute(_session, params) {
      captured = params.content;
    },
  });

  const raw = message(inmsg`anything goes here`);
  const match = router.match(session(raw), raw);

  assert.equal(match?.type, 'rawPattern');
  assert.deepEqual(match.activation, { type: 'direct' });
  assert.equal(await router.dispatch(session(raw), raw), true);
  assert.equal(captured, 'anything goes here');
  assert.equal(resolverCalled, false);
});

test('dispatches raw patterns registered with the builder syntax', async () => {
  const router = new Router();
  let captured = '';

  const rawPattern = router
    .rawPattern()
    .arg('content', param.greedy())
    .execute((_session, { content }) => {
      captured = content;
    });

  const handled = await dispatch(router, inmsg`anything goes here`);

  assert.deepEqual(Object.keys(rawPattern.pattern), ['content']);
  assert.equal(handled, true);
  assert.equal(captured, 'anything goes here');
});

test('rejects empty raw patterns', () => {
  const router = new Router();

  assert.throws(() => router.rawPattern({ pattern: {}, execute() {} }), /at least one parameter/);
  assert.throws(() => router.rawPattern().execute(() => {}), /at least one parameter/);
});

test('applies activation before the first literal in a raw pattern', async () => {
  const router = new Router();
  const calls: string[] = [];
  const reply = inseg.reply(message(inmsg`original`));

  router.setActivationResolver(() => [
    { type: 'mention' },
    { type: 'prefix', prefix: '/' },
    { type: 'mention', prefix: '/' },
  ]);
  router
    .rawPattern()
    .arg('reply', param.segment('reply'))
    .arg('command', param.literal('ddd'))
    .arg('action', param.literal('run'))
    .arg('content', param.greedy())
    .execute((_session, { content }) => {
      calls.push(content);
    });

  assert.equal(await dispatch(router, inmsg`${reply} ddd run direct`), false);
  assert.equal(await dispatch(router, inmsg`/${reply} ddd run misplaced`), false);
  assert.equal(await dispatch(router, inmsg`${reply} /ddd /run repeated`), false);
  assert.equal(await dispatch(router, inmsg`${reply} /ddd run prefixed`), true);
  assert.equal(await dispatch(router, inmsg`${reply}${inseg.mention(10001, 'bot')} ddd run mentioned`), true);
  assert.equal(await dispatch(router, inmsg`${reply}${inseg.mention(10001, 'bot')} /ddd run combined`), true);
  assert.deepEqual(calls, ['prefixed', 'mentioned', 'combined']);
});

test('applies activation before the first literal in filtered raw patterns', async () => {
  const router = new Router();
  const calls: string[] = [];
  const reply = inseg.reply(message(inmsg`original`));

  router.setActivationResolver(() => [
    { type: 'mention' },
    { type: 'prefix', prefix: '/' },
    { type: 'mention', prefix: '/' },
  ]);
  router
    .filter((currentSession) => currentSession.raw.sender_id === 7)
    .rawPattern({
      pattern: { reply: param.segment('reply'), command: param.literal('ddd'), content: param.greedy() },
      execute(_session, { content }) {
        calls.push(content);
      },
    });

  const rejected = message(inmsg`${reply} /ddd rejected`);
  const acceptedPrefix = { ...message(inmsg`${reply} /ddd prefixed`), sender_id: 7 };
  const acceptedMention = {
    ...message(inmsg`${reply}${inseg.mention(10001, 'bot')} ddd mentioned`),
    sender_id: 7,
  };
  const acceptedCombined = {
    ...message(inmsg`${reply}${inseg.mention(10001, 'bot')} /ddd combined`),
    sender_id: 7,
  };

  assert.equal(await router.dispatch(session(rejected), rejected), false);
  assert.equal(await router.dispatch(session(acceptedPrefix), acceptedPrefix), true);
  assert.equal(await router.dispatch(session(acceptedMention), acceptedMention), true);
  assert.equal(await router.dispatch(session(acceptedCombined), acceptedCombined), true);
  assert.deepEqual(calls, ['prefixed', 'mentioned', 'combined']);
});

test('captures non-text segments with segment parameters', async () => {
  const router = new Router();
  const target = inseg.mention(42, 'alice');
  let captured: milky.IncomingMentionSegment | undefined;

  router.command({
    name: 'poke',
    pattern: { target: param.segment('mention') },
    execute(_session, params) {
      captured = params.target;
    },
  });

  const handled = await dispatch(router, inmsg`poke ${target}`);

  assert.equal(handled, true);
  assert.deepEqual(captured, target);
});

test('does not let greedy capture span across non-text segments', async () => {
  const router = new Router();
  let called = false;

  router.command({
    name: 'say',
    pattern: { content: param.greedy() },
    execute() {
      called = true;
    },
  });

  const handled = await dispatch(router, inmsg`say hello ${inseg.mention(42)}`);

  assert.equal(handled, false);
  assert.equal(called, false);
});

test('greedy captures the rest of the current text segment and leaves following segments', async () => {
  const router = new Router();
  const target = inseg.mention(42, 'alice');
  let captured: { content: string; target: milky.IncomingMentionSegment } | undefined;

  router.command({
    name: 'say',
    pattern: { content: param.greedy(), target: param.segment('mention') },
    execute(_session, params) {
      captured = params;
    },
  });

  const handled = await dispatch(router, [inseg.text('say hello   world'), target]);

  assert.equal(handled, true);
  assert.deepEqual(captured, { content: 'hello   world', target });
});

test('catch-all captures remaining text and message segments', async () => {
  const router = new Router();
  const target = inseg.mention(42, 'alice');
  let captured: milky.IncomingSegment[] | undefined;

  router.command({
    name: 'reply',
    pattern: { content: param.catchAll() },
    execute(_session, params) {
      captured = params.content;
    },
  });

  const handled = await dispatch(router, [inseg.text('reply hello   world  '), target]);

  assert.equal(handled, true);
  assert.deepEqual(captured, [inseg.text('hello   world  '), target]);
});

test('catch-all captures remaining segments starting from a non-text segment', async () => {
  const router = new Router();
  const target = inseg.mention(42, 'alice');
  let captured: milky.IncomingSegment[] | undefined;

  router.command({
    name: 'reply',
    pattern: { content: param.catchAll() },
    execute(_session, params) {
      captured = params.content;
    },
  });

  const handled = await dispatch(router, inmsg`reply ${target}`);

  assert.equal(handled, true);
  assert.deepEqual(captured, [target]);
});

test('catch-all does not match empty remaining input', async () => {
  const router = new Router();
  let called = false;

  router.command({
    name: 'reply',
    pattern: { content: param.catchAll() },
    execute() {
      called = true;
    },
  });

  const handled = await dispatch(router, inmsg`reply`);

  assert.equal(handled, false);
  assert.equal(called, false);
});

test('raw pattern catch-all captures a mixed message', async () => {
  const router = new Router();
  const target = inseg.mention(42, 'alice');
  let captured: milky.IncomingSegment[] | undefined;

  router.rawPattern({
    pattern: { content: param.catchAll() },
    execute(_session, params) {
      captured = params.content;
    },
  });

  const handled = await dispatch(router, inmsg`hello ${target}`);

  assert.equal(handled, true);
  assert.deepEqual(captured, [inseg.text('hello '), target]);
});

test('builder sets description, aliases, and hidden on the command', () => {
  const router = new Router();

  const command = router
    .command('info')
    .describe('Shows information about the bot')
    .alias('i', 'about')
    .hide()
    .execute(() => {});

  assert.equal(command.name, 'info');
  assert.equal(command.description, 'Shows information about the bot');
  assert.deepEqual(command.aliases, ['i', 'about']);
  assert.equal(command.hidden, true);
});

test('builder sets description and aliases without hide', () => {
  const router = new Router();

  const command = router
    .command('ping')
    .describe('Responds with pong')
    .alias('p')
    .execute(() => {});

  assert.equal(command.description, 'Responds with pong');
  assert.deepEqual(command.aliases, ['p']);
  assert.equal(command.hidden, undefined);
});

test('dispatches a command via its alias', async () => {
  const router = new Router();
  let called = false;

  router.command({
    name: 'help',
    aliases: ['h', '?'],
    pattern: {},
    execute() {
      called = true;
    },
  });

  assert.equal(await dispatch(router, inmsg`h`), true);
  assert.equal(called, true);
});

test('dispatches a command via alias registered with builder', async () => {
  const router = new Router();
  let called = '';

  router
    .command('greet')
    .alias('g', 'hi')
    .arg('name', param.str())
    .execute((_session, { name }) => {
      called = name;
    });

  const handled = await dispatch(router, inmsg`hi world`);

  assert.equal(handled, true);
  assert.equal(called, 'world');
});

test('refine filters captured parameter values and narrows their type', async () => {
  const router = new Router();
  const calls: Array<{ userId: number }> = [];

  router.command({
    name: 'ban',
    pattern: {
      userId: param.num().refine((userId): userId is number & { readonly __positive: true } => userId > 0),
    },
    execute(_session, params) {
      calls.push(params);
    },
  });

  const accepted = await dispatch(router, inmsg`ban 42`);
  const rejected = await dispatch(router, inmsg`ban -42`);

  assert.equal(accepted, true);
  assert.equal(rejected, false);
  assert.deepEqual(calls, [{ userId: 42 }]);
});

test('matches command by name when name matches an earlier alias entry', async () => {
  const router = new Router();
  const calls: string[] = [];

  router.command({
    name: 'alpha',
    aliases: ['b'],
    pattern: {},
    execute() {
      calls.push('alpha');
    },
  });
  router.command({
    name: 'b',
    pattern: {},
    execute() {
      calls.push('b');
    },
  });

  assert.equal(await dispatch(router, inmsg`b`), true);
  assert.deepEqual(calls, ['b']);
});

test('match returns the matched command and params for alias dispatch', () => {
  const router = new Router();

  router.command({
    name: 'greet',
    aliases: ['g'],
    pattern: {},
    execute() {},
  });

  const raw = message(inmsg`g`);
  const match = router.match(session(raw), raw);

  assert.equal(match?.type, 'command');
  assert.equal(match.command.name, 'greet');
});

test('aliasesOf returns aliases for a registered command', () => {
  const router = new Router();

  router.command({
    name: 'help',
    aliases: ['h', '?'],
    pattern: {},
    execute() {},
  });

  assert.deepEqual(router.aliasesOf('help'), ['h', '?']);
});

test('aliasesOf returns empty array for command without aliases', () => {
  const router = new Router();

  router.command({
    name: 'ping',
    pattern: {},
    execute() {},
  });

  assert.deepEqual(router.aliasesOf('ping'), []);
});

test('aliasesOf returns empty array for unknown command', () => {
  const router = new Router();

  assert.deepEqual(router.aliasesOf('nonexistent'), []);
});

test('aliasesOf does not search inside groups', () => {
  const router = new Router();

  router.group('admin').command({
    name: 'ban',
    aliases: ['block'],
    pattern: { userId: param.num() },
    execute() {},
  });

  assert.deepEqual(router.aliasesOf('ban'), []);
});

test('aliasesOf works on group router directly', () => {
  const router = new Router();
  const admin = router.group('admin');

  admin.command({
    name: 'ban',
    aliases: ['block'],
    pattern: { userId: param.num() },
    execute() {},
  });

  assert.deepEqual(admin.aliasesOf('ban'), ['block']);
});

test('removes alias from existing command when new command name conflicts', () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(' '));
  };

  try {
    const router = new Router();

    router.command({
      name: 'first',
      aliases: ['f', 'common'],
      pattern: {},
      execute() {},
    });

    router.command({
      name: 'common',
      pattern: {},
      execute() {},
    });

    assert.deepEqual(router.aliasesOf('first'), ['f']);
    assert.deepEqual(router.aliasesOf('common'), []);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('conflicts with alias'));
    assert.ok(warnings[0].includes('first'));
    assert.ok(warnings[0].includes('common'));
  } finally {
    console.warn = originalWarn;
  }
});

test('drops new alias that conflicts with an existing command name', () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(' '));
  };

  try {
    const router = new Router();

    router.command({
      name: 'existing',
      pattern: {},
      execute() {},
    });

    router.command({
      name: 'new',
      aliases: ['existing', 'n'],
      pattern: {},
      execute() {},
    });

    assert.deepEqual(router.aliasesOf('new'), ['n']);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('has been dropped'));
  } finally {
    console.warn = originalWarn;
  }
});

test('removes alias from existing command when new alias conflicts', () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(' '));
  };

  try {
    const router = new Router();

    router.command({
      name: 'alpha',
      aliases: ['x'],
      pattern: {},
      execute() {},
    });

    router.command({
      name: 'beta',
      aliases: ['x'],
      pattern: {},
      execute() {},
    });

    assert.deepEqual(router.aliasesOf('alpha'), []);
    assert.deepEqual(router.aliasesOf('beta'), ['x']);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('removed'));
  } finally {
    console.warn = originalWarn;
  }
});

test('hidden commands are not listed in branches', () => {
  const router = new Router();

  router.command({ name: 'visible', pattern: {}, execute() {} });
  router.command({ name: 'hidden', pattern: {}, hidden: true, execute() {} });

  const raw = message(inmsg`anything`);
  const branches = router.branches(session(raw));

  const names = branches
    .filter((b) => b.type === 'command')
    .map((b) => (b as { type: 'command'; command: { name: string } }).command.name);

  assert.deepEqual(names, ['visible']);
});

test('hidden commands still dispatch', async () => {
  const router = new Router();
  let called = false;

  router.command({
    name: 'secret',
    hidden: true,
    pattern: {},
    execute() {
      called = true;
    },
  });

  assert.equal(await dispatch(router, inmsg`secret`), true);
  assert.equal(called, true);
});

test('hidden command via builder is not listed in branches', () => {
  const router = new Router();

  router.command('show').execute(() => {});
  router
    .command('hide')
    .hide()
    .execute(() => {});

  const raw = message(inmsg`anything`);
  const branches = router.branches(session(raw));

  const names = branches
    .filter((b) => b.type === 'command')
    .map((b) => (b as { type: 'command'; command: { name: string } }).command.name);

  assert.deepEqual(names, ['show']);
});

test('command via object literal supports description and aliases fields', () => {
  const router = new Router();
  let called = false;

  router.command({
    name: 'greet',
    description: 'Sends a greeting',
    aliases: ['g', 'hello'],
    pattern: {},
    execute() {
      called = true;
    },
  });

  assert.equal(router.aliasesOf('greet').length, 2);
  assert.equal(called, false);
});

test('rejects catch-all parameters before the end of a pattern', () => {
  const router = new Router();

  assert.throws(
    () =>
      router.command({
        name: 'reply',
        pattern: { content: param.catchAll(), label: param.str() },
        execute() {},
      }),
    /Catch-all parameters must be the last parameter/,
  );
  assert.throws(
    () =>
      router.rawPattern({
        pattern: { content: param.catchAll(), label: param.str() },
        execute() {},
      }),
    /Catch-all parameters must be the last parameter/,
  );
  assert.throws(
    () =>
      router
        .command('reply')
        .arg('content', param.catchAll())
        .arg('label', param.str())
        .execute(() => {}),
    /Catch-all parameters must be the last parameter/,
  );
  assert.throws(
    () =>
      router
        .rawPattern()
        .arg('content', param.catchAll())
        .arg('label', param.str())
        .execute(() => {}),
    /Catch-all parameters must be the last parameter/,
  );
});
