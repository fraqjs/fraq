import type { Disposable } from '@fraqjs/fraq';
import type { Kysely } from 'kysely';

import { SchemaRegistry } from './schema';
import type { FraqDatabase } from './types';

export class KyselyService implements Disposable {
  readonly schemas: SchemaRegistry;

  constructor(readonly db: Kysely<FraqDatabase>) {
    this.schemas = new SchemaRegistry(db);
  }

  async dispose() {
    await this.db.destroy();
  }
}
