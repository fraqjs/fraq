import type { Disposable } from '@fraqjs/fraq';
import { type Kysely, sql } from 'kysely';

import { SchemaRegistry } from './schema';
import type { FraqDatabase } from './types';

export interface KyselyAutoVacuumOptions {
  enabled?: boolean;
  intervalMinutes?: number;
}

export class KyselyService implements Disposable {
  readonly schemas: SchemaRegistry;

  constructor(
    readonly db: Kysely<FraqDatabase>,
    readonly autoVacuum?: KyselyAutoVacuumOptions,
  ) {
    this.schemas = new SchemaRegistry(db);
  }

  async vacuum(): Promise<void> {
    await sql`VACUUM`.execute(this.db);
  }

  async dispose() {
    await this.db.destroy();
  }
}
