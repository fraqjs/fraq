import { definePlugin } from '@fraqjs/fraq';
import { createMockContext } from '@fraqjs/plugin-mock';
import type { Kysely } from 'kysely';

import KyselyPlugin, { KyselyService } from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

interface TestDatabase {
  user_account: {
    id: number;
    name: string;
  };
}

test('provides a working Kysely database service backed by node:sqlite', async () => {
  const ctx = createMockContext();

  ctx.install(KyselyPlugin, { sqliteUrl: ':memory:' });
  await ctx.start();

  const db = ctx.resolve(KyselyService).db as unknown as Kysely<TestDatabase>;

  await db.schema
    .createTable('user_account')
    .addColumn('id', 'integer', (column) => column.primaryKey())
    .addColumn('name', 'text', (column) => column.notNull())
    .execute();

  await db.insertInto('user_account').values({ id: 1, name: 'alpha' }).execute();

  const row = await db.selectFrom('user_account').selectAll().executeTakeFirst();

  assert.ok(row);
  assert.equal(row.id, 1);
  assert.equal(row.name, 'alpha');

  await ctx.stop();
});

test('vacuums the database automatically after startup', async () => {
  const ctx = createMockContext();
  let vacuumRuns = 0;

  ctx.install(KyselyPlugin, { sqliteUrl: ':memory:' });
  ctx.install(
    definePlugin({
      name: 'observe-vacuum',
      requires: [KyselyService],
      apply(ctx) {
        const service = ctx.resolve(KyselyService);
        const vacuum = service.vacuum.bind(service);
        service.vacuum = async () => {
          vacuumRuns += 1;
          await vacuum();
        };
      },
    }),
  );

  await ctx.start();

  assert.equal(vacuumRuns, 1);
  await ctx.stop();
});

test('allows automatic vacuum to be disabled', async () => {
  const ctx = createMockContext();
  let vacuumRuns = 0;

  ctx.install(KyselyPlugin, {
    sqliteUrl: ':memory:',
    autoVacuum: { enabled: false },
  });
  ctx.install(
    definePlugin({
      name: 'observe-disabled-vacuum',
      requires: [KyselyService],
      apply(ctx) {
        const service = ctx.resolve(KyselyService);
        const vacuum = service.vacuum.bind(service);
        service.vacuum = async () => {
          vacuumRuns += 1;
          await vacuum();
        };
      },
    }),
  );

  await ctx.start();

  assert.equal(vacuumRuns, 0);
  await ctx.stop();
});
