import type { Context } from '@fraqjs/fraq';
import type { Tool } from 'ai';
import { z } from 'zod';

import * as mz from './types-zod';

export type ToolApiEndpoint = keyof typeof mz.zodApiEndpoints;

export function milkyToolset<T extends ToolApiEndpoint>(ctx: Context, endpoints: T[]): Record<T, Tool> {
  const tools: Record<string, Tool> = {};
  for (const endpoint of endpoints) {
    const endpointDesc = mz.zodApiEndpoints[endpoint];
    tools[endpoint] = {
      description: endpointDesc.description,
      inputSchema: endpointDesc.requestSchema ?? z.object({}),
      outputSchema: endpointDesc.responseSchema ?? z.object({}),
      execute: async (input) => {
        return (await ctx.client[endpoint](input)) ?? {};
      },
    };
  }
  return tools as Record<T, Tool>;
}
