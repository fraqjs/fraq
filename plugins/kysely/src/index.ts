import { definePlugin } from '@fraqjs/fraq';
import { Kysely, SqliteDialect } from 'kysely';

import { NodeSqliteDatabaseAdapter } from './node-sqlite-adapter';
import { type KyselyAutoVacuumOptions, KyselyService } from './service';
import type { FraqDatabase } from './types';

import { DatabaseSync, type DatabaseSyncOptions } from 'node:sqlite';

export interface KyselyPluginOptions {
  sqliteUrl?: string;
  nodeSqliteOptions?: Omit<DatabaseSyncOptions, 'open'>;
  autoVacuum?: KyselyAutoVacuumOptions;
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
    ctx.provide(KyselyService, new KyselyService(kysely, options?.autoVacuum));
  },
  async start(ctx) {
    ctx.logger.info('Migrating database schema to latest version...');
    const service = ctx.resolve(KyselyService);
    await service.schemas.migrateToLatest();

    if (service.autoVacuum?.enabled === false) {
      return;
    }

    const intervalMinutes = service.autoVacuum?.intervalMinutes ?? 60;
    let vacuumInProgress = false;
    const vacuum = async () => {
      if (vacuumInProgress) {
        return;
      }
      vacuumInProgress = true;
      try {
        await service.vacuum();
        ctx.logger.debug('Vacuumed SQLite database.');
      } finally {
        vacuumInProgress = false;
      }
    };

    await vacuum();
    ctx.interval(intervalMinutes * 60 * 1_000, vacuum);
  },
});

export * from './schema';
export * from './service';
export * from './types';

export default KyselyPlugin;
