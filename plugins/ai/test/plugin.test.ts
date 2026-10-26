import { createMockContext } from '@fraqjs/plugin-mock';

import AiPlugin, { AiService, ai } from '../src';
import { mockImageModel, mockLanguageModel } from './util/mock';

import assert from 'node:assert/strict';
import test from 'node:test';

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
  assert.equal(service.hasModel('missing'), false);

  const result = await ai.generateText({ model: service.model('fast'), prompt: 'hi' });
  assert.equal(result.text, 'from mini');

  await ctx.stop();
});

test('AiPlugin registers image models from direct provider instances', async () => {
  const ctx = createMockContext();
  const dalle = mockImageModel('aGVsbG8=');
  const imagen = mockImageModel('d29ybGQ=');

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
      google: {
        imageModels: { imagen },
      },
    },
    aliases: {
      art: 'openai/gpt-image-2',
      alternative: 'google/imagen',
    },
    defaultImageModel: 'art',
  });
  await ctx.start();

  const service = ctx.resolve(AiService);

  assert.deepEqual(new Set(service.images()), new Set(['openai/gpt-image-2', 'google/imagen']));
  assert.equal(service.image(), dalle);
  assert.equal(service.image('openai/gpt-image-2'), dalle);
  assert.equal(service.image('art'), dalle);
  assert.equal(service.image('google/imagen'), imagen);
  assert.equal(service.image('alternative'), imagen);
  assert.equal(service.hasImage('art'), true);
  assert.equal(service.hasImage('google/imagen'), true);
  assert.equal(service.hasImage('missing'), false);

  const result = await ai.generateImage({ model: service.image(), prompt: 'a cat' });
  assert.equal(result.image.base64, 'aGVsbG8=');

  await ctx.stop();
});
