import { createMockContext } from '@fraqjs/plugin-mock';
import { generateImage, generateText } from 'ai';

import AiPlugin, { AiService } from '../src';
import { mockImageModel, mockLanguageModel } from './util/mock';

import assert from 'node:assert/strict';
import test from 'node:test';

test('AiPlugin provides AiService through the context', async () => {
  const ctx = createMockContext();

  ctx.install(AiPlugin, {
    providers: {
      test: {
        models: {
          model: mockLanguageModel('from plugin'),
        },
      },
    },
  });
  await ctx.start();

  const result = await generateText({ model: ctx.resolve(AiService).model(), prompt: 'hi' });

  assert.equal(result.text, 'from plugin');

  await ctx.stop();
});

test('AiPlugin registers multiple provider aliases, default model, and all concrete models', async () => {
  const ctx = createMockContext();
  const primary = mockLanguageModel('from primary');
  const mini = mockLanguageModel('from mini');
  const sonnet = mockLanguageModel('from sonnet');

  ctx.install(AiPlugin, {
    providers: {
      openai: {
        models: {
          primary,
          mini,
        },
      },
      anthropic: {
        models: {
          sonnet,
        },
      },
    },
    aliases: {
      default: 'openai/primary',
      fast: 'openai/mini',
      claude: 'anthropic/sonnet',
    },
    defaultModel: 'anthropic/sonnet',
  });
  await ctx.start();

  const service = ctx.resolve(AiService);

  assert.deepEqual(service.models(), ['openai/primary', 'openai/mini', 'anthropic/sonnet']);
  assert.equal(service.model(), sonnet);
  assert.equal(service.model('openai/primary'), primary);
  assert.equal(service.model('fast'), mini);
  assert.equal(service.model('claude'), sonnet);
  assert.equal(service.hasModel('default'), true);
  assert.equal(service.hasModel('anthropic/sonnet'), true);

  const result = await generateText({ model: service.model('fast'), prompt: 'hi' });
  assert.equal(result.text, 'from mini');

  await ctx.stop();
});

test('AiPlugin registers image models from direct provider instances', async () => {
  const ctx = createMockContext();
  const dalle = mockImageModel('aGVsbG8=');

  ctx.install(AiPlugin, {
    providers: {
      openai: {
        models: {
          'gpt-4o': mockLanguageModel('text'),
        },
        imageModels: {
          'gpt-image-2': dalle,
        },
      },
    },
    aliases: {
      art: 'openai/gpt-image-2',
    },
    defaultImageModel: 'art',
  });
  await ctx.start();

  const service = ctx.resolve(AiService);

  assert.deepEqual(service.images(), ['openai/gpt-image-2']);
  assert.equal(service.image(), dalle);
  assert.equal(service.image('art'), dalle);
  assert.equal(service.hasImage('art'), true);

  const result = await generateImage({ model: service.image(), prompt: 'a cat' });
  assert.equal(result.image.base64, 'aGVsbG8=');

  await ctx.stop();
});
