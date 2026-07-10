import { Context } from '@fraqjs/fraq';
import { createMockMilkyClient } from '@fraqjs/mock';
import { asSchema, generateText, jsonSchema, streamText, tool } from 'ai';

import { AiService, milkyToolset } from '../src';
import { mockLanguageModel, mockToolCallModel } from './util/mock';

import assert from 'node:assert/strict';
import test from 'node:test';

test('AiService exposes the configured model', () => {
  const model = mockLanguageModel('hello');
  const service = new AiService({
    models: {
      'test/model': model,
    },
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
        aliases: {
          missing: 'test/missing',
        },
        defaultModel: 'test/model',
      }),
    /Invalid alias "missing": target model "test\/missing" does not exist/,
  );
});

test('AiService constructor rejects a missing default model', () => {
  assert.throws(
    () =>
      new AiService({
        models: {
          'test/model': mockLanguageModel('hello'),
        },
        aliases: {},
        defaultModel: 'test/missing',
      }),
    /Invalid default model "test\/missing": model does not exist/,
  );
});

test('the exposed model works with the raw generateText function', async () => {
  const service = new AiService({
    models: {
      'test/model': mockLanguageModel('hello from the model'),
    },
    aliases: {},
    defaultModel: 'test/model',
  });

  const result = await generateText({ model: service.model(), prompt: 'hi' });

  assert.equal(result.text, 'hello from the model');
});

test('the exposed model works with the raw streamText function', async () => {
  const service = new AiService({
    models: {
      'test/model': mockLanguageModel('streamed text'),
    },
    aliases: {},
    defaultModel: 'test/model',
  });

  const result = streamText({ model: service.model(), prompt: 'hi' });

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
    aliases: {},
    defaultModel: 'test/model',
  });

  const result = await generateText({
    model: service.model(),
    prompt: 'What is the weather in Tokyo?',
    tools: {
      weather: tool({
        description: 'Get the weather for a city',
        inputSchema: jsonSchema<{ city: string }>({
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
  const ctx = Context.fromClient(createMockMilkyClient());

  const tools = milkyToolset(ctx, ['get_login_info', 'set_nickname']);

  assert.deepEqual(Object.keys(tools), ['get_login_info', 'set_nickname']);
  assert.equal(tools.get_login_info.description, '获取登录信息');
  assert.equal(tools.set_nickname.description, '设置 QQ 账号昵称');

  const loginInput = await asSchema(tools.get_login_info.inputSchema).validate?.({});
  assert.deepEqual(loginInput, { success: true, value: {} });

  const nicknameInputSchema = asSchema(tools.set_nickname.inputSchema);
  const validNicknameInput = await nicknameInputSchema.validate?.({ new_nickname: 'Fraq' });
  assert.deepEqual(validNicknameInput, { success: true, value: { new_nickname: 'Fraq' } });
  assert.equal((await nicknameInputSchema.validate?.({}))?.success, false);

  const loginOutput = await asSchema(tools.get_login_info.outputSchema).validate?.({
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

  const nicknameOutput = await asSchema(tools.set_nickname.outputSchema).validate?.({});
  assert.deepEqual(nicknameOutput, { success: true, value: {} });
});

test('toolset tools execute the matching API through the context client', async () => {
  const client = createMockMilkyClient();
  client.stubApi('get_login_info', () => ({
    uin: 10001,
    nickname: 'Fraq',
  }));
  const ctx = Context.fromClient(client);
  const service = new AiService({
    models: {
      'test/model': mockToolCallModel('get_login_info', {}),
    },
    aliases: {},
    defaultModel: 'test/model',
  });

  const result = await generateText({
    model: service.model(),
    prompt: 'Who is logged in?',
    tools: milkyToolset(ctx, ['get_login_info']),
  });

  assert.deepEqual(result.toolResults[0]?.output, {
    uin: 10001,
    nickname: 'Fraq',
  });
  assert.deepEqual(client.apiCalls, [
    {
      endpoint: 'get_login_info',
      params: {},
    },
  ]);
});

test('toolset tools normalize empty API responses to an object', async () => {
  const client = createMockMilkyClient();
  const ctx = Context.fromClient(client);
  const service = new AiService({
    models: {
      'test/model': mockToolCallModel('set_nickname', { new_nickname: 'Fraq' }),
    },
    aliases: {},
    defaultModel: 'test/model',
  });

  const result = await generateText({
    model: service.model(),
    prompt: 'Change the nickname to Fraq.',
    tools: milkyToolset(ctx, ['set_nickname']),
  });

  assert.deepEqual(result.toolResults[0]?.output, {});
  assert.deepEqual(client.apiCalls, [
    {
      endpoint: 'set_nickname',
      params: { new_nickname: 'Fraq' },
    },
  ]);
});
