import { definePlugin } from '@fraqjs/fraq';
import { Kysely, SqliteDialect } from 'kysely';

import { NodeSqliteDatabaseAdapter } from './node-sqlite-adapter';
import { KyselyService } from './service';
import type { FraqDatabase } from './types';

import { DatabaseSync, type DatabaseSyncOptions } from 'node:sqlite';

export interface KyselyPluginOptions {
  sqliteUrl?: string;
  nodeSqliteOptions?: Omit<DatabaseSyncOptions, 'open'>;
}

export const KyselyPlugin = definePlugin({
  name: 'kysely',
  provides: [KyselyService],
  apply(ctx, options?: KyselyPluginOptions) {
    const sqliteUrl = options?.sqliteUrl ?? 'file:./fraq.db';
    const kysely = new Kysely<FraqDatabase>({
      dialect: new SqliteDialect({
        database: new NodeSqliteDatabaseAdapter(new DatabaseSync(sqliteUrl, options?.nodeSqliteOptions ?? {})),
      }),
    });
    ctx.provide(KyselyService, new KyselyService(kysely));
  },
  async start(ctx) {
    ctx.logger.info('Migrating database schema to latest version...');
    await ctx.resolve(KyselyService).schemas.migrateToLatest();
  },
});

export * from './schema';
export * from './service';
export * from './types';

export default KyselyPlugin;
