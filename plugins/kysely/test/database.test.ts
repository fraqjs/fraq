import { definePlugin } from '@fraqjs/fraq';
import { createMockContext } from '@fraqjs/plugin-mock';
import { sql } from 'kysely';

import KyselyPlugin, { KyselyService } from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

async function freePagesAfterStartup(enabled?: boolean): Promise<number> {
  const ctx = createMockContext();
  ctx.install(KyselyPlugin, { sqliteUrl: ':memory:', autoVacuum: { enabled } });
  ctx.install(
    definePlugin({
      name: 'vacuum-fixture',
      inject: { kysely: KyselyService },
      apply(ctx) {
        ctx.kysely.schemas.register({
          name: 'vacuum-fixture',
          migrations: {
            '001_create_free_pages': {
              async up(db) {
                await sql`CREATE TABLE vacuum_fixture (payload BLOB)`.execute(db);
                await sql`INSERT INTO vacuum_fixture VALUES (zeroblob(1048576))`.execute(db);
                await sql`DELETE FROM vacuum_fixture`.execute(db);
                const result = await sql<{ freelist_count: number }>`PRAGMA freelist_count`.execute(db);
                assert.ok(result.rows[0].freelist_count > 0, 'fixture must have reusable pages before vacuum');
              },
            },
          },
        });
      },
    }),
  );
  try {
    await ctx.start();
    const result = await sql<{ freelist_count: number }>`PRAGMA freelist_count`.execute(ctx.resolve(KyselyService).db);
    return result.rows[0].freelist_count;
  } finally {
    await ctx.stop();
  }
}

test('vacuums the database automatically after startup', async () => {
  assert.equal(await freePagesAfterStartup(), 0);
});

test('allows automatic vacuum to be disabled', async () => {
  assert.ok((await freePagesAfterStartup(false)) > 0);
});
