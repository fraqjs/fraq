import { buildStartScript } from '../src/app/start-script';
import type { Config } from '../src/config';

import assert from 'node:assert/strict';
import test from 'node:test';

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
});
