import { createMockContext } from '@fraqjs/plugin-mock';

import { AiService, ai, milkyToolset } from '../src';
import { zodApiEndpoints } from '../src/protocol/types-zod';
import { mockImageModel, mockLanguageModel, mockToolCallModel } from './util/mock';

import assert from 'node:assert/strict';
import test from 'node:test';

test('AiService throws for unknown model names', () => {
  const service = new AiService({
    languageModels: {
      'test/model': mockLanguageModel('hello'),
    },
    imageModels: {},
    aliases: {},
    defaultModel: 'test/model',
  });

  assert.throws(() => service.model('missing'), /Model not found: missing/);
});

test('AiService constructor rejects aliases that point to missing models', () => {
  assert.throws(
    () =>
      new AiService({
        languageModels: {
          'test/model': mockLanguageModel('hello'),
        },
        imageModels: {},
        aliases: {
          missing: 'test/missing',
        },
        defaultModel: 'test/model',
      }),
    /Invalid alias "missing": target model "test\/missing" does not exist/,
  );
});

test('AiService constructor rejects an invalid default model', () => {
  assert.throws(
    () =>
      new AiService({
        languageModels: {
          'test/model': mockLanguageModel('hello'),
        },
        imageModels: {},
        aliases: {},
        defaultModel: 'test/missing',
      }),
    /Model not found: test\/missing/,
  );
});

test('AiService creates tools from the selected Milky endpoint metadata', async () => {
  const ctx = createMockContext();

  const tools = milkyToolset(ctx, ['get_login_info', 'set_nickname']);

  assert.deepEqual(Object.keys(tools), ['get_login_info', 'set_nickname']);
  for (const endpoint of ['get_login_info', 'set_nickname'] as const) {
    assert.ok(tools[endpoint].description);
    assert.equal(tools[endpoint].description, zodApiEndpoints[endpoint].description);
  }

  const loginInput = await ai.asSchema(tools.get_login_info.inputSchema).validate?.({});
  assert.deepEqual(loginInput, { success: true, value: {} });

  const nicknameInputSchema = ai.asSchema(tools.set_nickname.inputSchema);
  const validNicknameInput = await nicknameInputSchema.validate?.({ new_nickname: 'Fraq' });
  assert.deepEqual(validNicknameInput, { success: true, value: { new_nickname: 'Fraq' } });
  assert.equal((await nicknameInputSchema.validate?.({}))?.success, false);

  const loginOutput = await ai.asSchema(tools.get_login_info.outputSchema).validate?.({
    uin: 10001,
    nickname: 'Fraq',
  });
  assert.deepEqual(loginOutput, {
    success: true,
    value: {
      uin: 10001,
      nickname: 'Fraq',
    },
  });

  const nicknameOutput = await ai.asSchema(tools.set_nickname.outputSchema).validate?.({});
  assert.deepEqual(nicknameOutput, { success: true, value: {} });
});

test('toolset tools execute the matching API through the context client', async () => {
  const ctx = createMockContext();
  ctx.hookApi('get_login_info', async (_params, next) => {
    await next();
    return { uin: 10001, nickname: 'Fraq' };
  });
  const service = new AiService({
    languageModels: {
      'test/model': mockToolCallModel('get_login_info', {}),
    },
    imageModels: {},
    aliases: {},
    defaultModel: 'test/model',
  });

  const result = await ai.generateText({
    model: service.model(),
    prompt: 'Who is logged in?',
    tools: milkyToolset(ctx, ['get_login_info']),
  });

  assert.deepEqual(result.toolResults[0]?.output, {
    uin: 10001,
    nickname: 'Fraq',
  });
  assert.deepEqual(ctx.mock.apiCalls, [
    {
      endpoint: 'get_login_info',
      params: {},
    },
  ]);
});

test('toolset tools normalize empty API responses to an object', async () => {
  const ctx = createMockContext();
  const service = new AiService({
    languageModels: {
      'test/model': mockToolCallModel('set_nickname', { new_nickname: 'Fraq' }),
    },
    imageModels: {},
    aliases: {},
    defaultModel: 'test/model',
  });

  const result = await ai.generateText({
    model: service.model(),
    prompt: 'Change the nickname to Fraq.',
    tools: milkyToolset(ctx, ['set_nickname']),
  });

  assert.deepEqual(result.toolResults[0]?.output, {});
  assert.deepEqual(ctx.mock.apiCalls, [
    {
      endpoint: 'set_nickname',
      params: { new_nickname: 'Fraq' },
    },
  ]);
});

test('AiService throws for unknown image model names', () => {
  const service = new AiService({
    languageModels: {},
    imageModels: {
      'test/dall-e': mockImageModel('aGVsbG8='),
    },
    aliases: {},
  });

  assert.throws(() => service.image('missing'), /Image model not found: missing/);
});

test('AiService throws when no image model is configured', () => {
  const service = new AiService({
    languageModels: {
      'test/model': mockLanguageModel('text'),
    },
    imageModels: {},
    aliases: {},
    defaultModel: 'test/model',
  });

  assert.throws(() => service.image(), /No image model configured/);
});

test('AiService rejects an alias pointing to an image model when accessed via model()', () => {
  const service = new AiService({
    languageModels: {},
    imageModels: {
      'test/dall-e': mockImageModel('aGVsbG8='),
    },
    aliases: {
      art: 'test/dall-e',
    },
  });

  assert.throws(() => service.model('art'), /Model not found: art/);
});

test('AiService constructor rejects an invalid defaultImage', () => {
  assert.throws(
    () =>
      new AiService({
        languageModels: {},
        imageModels: {
          'test/dall-e': mockImageModel('aGVsbG8='),
        },
        aliases: {},
        defaultImageModel: 'test/missing',
      }),
    /Image model not found: test\/missing/,
  );
});
