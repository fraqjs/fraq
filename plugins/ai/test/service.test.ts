import { createMockContext } from '@fraqjs/plugin-mock';

import { AiService, ai, milkyToolset } from '../src';
import { mockImageModel, mockLanguageModel, mockToolCallModel } from './util/mock';

import assert from 'node:assert/strict';
import test from 'node:test';

test('AiService exposes the configured model', () => {
  const model = mockLanguageModel('hello');
  const service = new AiService({
    models: {
      'test/model': model,
    },
    images: {},
    aliases: {},
    defaultModel: 'test/model',
  });

  assert.equal(service.model(), model);
});

test('AiService resolves models by name and alias', () => {
  const primary = mockLanguageModel('primary');
  const fallback = mockLanguageModel('fallback');
  const service = new AiService({
    models: {
      'openai/gpt-4o': primary,
      'anthropic/claude-sonnet': fallback,
    },
    images: {},
    aliases: {
      openai: 'openai/gpt-4o',
      claude: 'anthropic/claude-sonnet',
    },
    defaultModel: 'anthropic/claude-sonnet',
  });

  assert.equal(service.model(), fallback);
  assert.equal(service.model('openai/gpt-4o'), primary);
  assert.equal(service.model('openai'), primary);
  assert.equal(service.model('claude'), fallback);
  assert.equal(service.hasModel('openai/gpt-4o'), true);
  assert.equal(service.hasModel('openai'), true);
  assert.equal(service.hasModel('missing'), false);
});

test('AiService exposes a list of all model names', () => {
  const first = mockLanguageModel('first');
  const second = mockLanguageModel('second');
  const service = new AiService({
    models: {
      'test/first': first,
      'test/second': second,
    },
    images: {},
    aliases: {
      first: 'test/first',
    },
    defaultModel: 'test/first',
  });

  assert.deepEqual(service.models(), ['test/first', 'test/second']);
});

test('AiService throws for unknown model names', () => {
  const service = new AiService({
    models: {
      'test/model': mockLanguageModel('hello'),
    },
    images: {},
    aliases: {},
    defaultModel: 'test/model',
  });

  assert.throws(() => service.model('missing'), /Model not found: missing/);
});

test('AiService constructor rejects aliases that point to missing models', () => {
  assert.throws(
    () =>
      new AiService({
        models: {
          'test/model': mockLanguageModel('hello'),
        },
        images: {},
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
        models: {
          'test/model': mockLanguageModel('hello'),
        },
        images: {},
        aliases: {},
        defaultModel: 'test/missing',
      }),
    /Model not found: test\/missing/,
  );
});

test('the exposed model works with the raw generateText function', async () => {
  const service = new AiService({
    models: {
      'test/model': mockLanguageModel('hello from the model'),
    },
    images: {},
    aliases: {},
    defaultModel: 'test/model',
  });

  const result = await ai.generateText({ model: service.model(), prompt: 'hi' });

  assert.equal(result.text, 'hello from the model');
});

test('the exposed model works with the raw streamText function', async () => {
  const service = new AiService({
    models: {
      'test/model': mockLanguageModel('streamed text'),
    },
    images: {},
    aliases: {},
    defaultModel: 'test/model',
  });

  const result = ai.streamText({ model: service.model(), prompt: 'hi' });

  let collected = '';
  for await (const part of result.textStream) {
    collected += part;
  }

  assert.equal(collected, 'streamed text');
});

test('the exposed model supports tool calling with full type inference', async () => {
  const service = new AiService({
    models: {
      'test/model': mockToolCallModel('weather', { city: 'Tokyo' }),
    },
    images: {},
    aliases: {},
    defaultModel: 'test/model',
  });

  const result = await ai.generateText({
    model: service.model(),
    prompt: 'What is the weather in Tokyo?',
    tools: {
      weather: ai.tool({
        description: 'Get the weather for a city',
        inputSchema: ai.jsonSchema<{ city: string }>({
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        }),
        execute: async ({ city }) => `sunny in ${city}`,
      }),
    },
  });

  assert.equal(result.toolCalls[0]?.toolName, 'weather');
  assert.deepEqual(result.toolCalls[0]?.input, { city: 'Tokyo' });
  assert.equal(result.toolResults[0]?.output, 'sunny in Tokyo');
});

test('AiService creates tools from the selected Milky endpoint metadata', async () => {
  const ctx = createMockContext();

  const tools = milkyToolset(ctx, ['get_login_info', 'set_nickname']);

  assert.deepEqual(Object.keys(tools), ['get_login_info', 'set_nickname']);
  assert.equal(tools.get_login_info.description, '获取登录信息');
  assert.equal(tools.set_nickname.description, '设置 QQ 账号昵称');

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
    models: {
      'test/model': mockToolCallModel('get_login_info', {}),
    },
    images: {},
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
    models: {
      'test/model': mockToolCallModel('set_nickname', { new_nickname: 'Fraq' }),
    },
    images: {},
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

test('AiService exposes the configured image model', () => {
  const image = mockImageModel('aGVsbG8=');
  const service = new AiService({
    models: {},
    images: {
      'test/dall-e': image,
    },
    aliases: {},
  });

  assert.equal(service.image(), image);
});

test('AiService resolves image models by name and alias', () => {
  const primary = mockImageModel('aGVsbG8=');
  const fallback = mockImageModel('d29ybGQ=');
  const service = new AiService({
    models: {
      'openai/gpt-4o': mockLanguageModel('text'),
    },
    images: {
      'openai/gpt-image-2': primary,
      'google/imagen': fallback,
    },
    aliases: {
      art: 'openai/gpt-image-2',
      google: 'google/imagen',
    },
    defaultModel: 'openai/gpt-4o',
    defaultImageModel: 'google/imagen',
  });

  assert.equal(service.image(), fallback);
  assert.equal(service.image('openai/gpt-image-2'), primary);
  assert.equal(service.image('art'), primary);
  assert.equal(service.image('google'), fallback);
  assert.equal(service.hasImage('art'), true);
  assert.equal(service.hasImage('openai/gpt-image-2'), true);
  assert.equal(service.hasImage('missing'), false);
});

test('AiService exposes a list of all image model names', () => {
  const service = new AiService({
    models: {
      'test/model': mockLanguageModel('text'),
    },
    images: {
      'test/dall-e': mockImageModel('aGVsbG8='),
      'test/imagen': mockImageModel('d29ybGQ='),
    },
    aliases: {},
    defaultModel: 'test/model',
  });

  assert.deepEqual(service.images(), ['test/dall-e', 'test/imagen']);
});

test('AiService throws for unknown image model names', () => {
  const service = new AiService({
    models: {},
    images: {
      'test/dall-e': mockImageModel('aGVsbG8='),
    },
    aliases: {},
  });

  assert.throws(() => service.image('missing'), /Image model not found: missing/);
});

test('AiService throws when no image model is configured', () => {
  const service = new AiService({
    models: {
      'test/model': mockLanguageModel('text'),
    },
    images: {},
    aliases: {},
    defaultModel: 'test/model',
  });

  assert.throws(() => service.image(), /No image model configured/);
});

test('AiService rejects an alias pointing to an image model when accessed via model()', () => {
  const service = new AiService({
    models: {},
    images: {
      'test/dall-e': mockImageModel('aGVsbG8='),
    },
    aliases: {
      art: 'test/dall-e',
    },
  });

  assert.throws(() => service.model('art'), /Model not found: art/);
});

test('the exposed image model works with the raw generateImage function', async () => {
  const service = new AiService({
    models: {},
    images: {
      'test/dall-e': mockImageModel('aGVsbG8='),
    },
    aliases: {},
  });

  const result = await ai.generateImage({ model: service.image(), prompt: 'a cat' });

  assert.equal(result.image.base64, 'aGVsbG8=');
});

test('AiService constructor accepts a defaultImage alias', () => {
  const image = mockImageModel('aGVsbG8=');
  const service = new AiService({
    models: {},
    images: {
      'test/dall-e': image,
    },
    aliases: {
      art: 'test/dall-e',
    },
    defaultImageModel: 'art',
  });

  assert.equal(service.image(), image);
});

test('AiService constructor rejects an invalid defaultImage', () => {
  assert.throws(
    () =>
      new AiService({
        models: {},
        images: {
          'test/dall-e': mockImageModel('aGVsbG8='),
        },
        aliases: {},
        defaultImageModel: 'test/missing',
      }),
    /Image model not found: test\/missing/,
  );
});
