// biome-ignore lint/suspicious/noConfusingVoidType: Cleanup hooks should accept ordinary void-returning functions.
export type SubsystemCleanupResult = void | readonly unknown[];

export interface SubsystemHooks<T> {
  start?(value: T): void | Promise<void>;
  activate?(value: T): void | Promise<void>;
  suspend?(value: T): void;
  deactivate?(value: T): SubsystemCleanupResult | Promise<SubsystemCleanupResult>;
  stop?(value: T): SubsystemCleanupResult | Promise<SubsystemCleanupResult>;
}

export interface SubsystemDefinition<T> extends SubsystemHooks<T> {
  readonly name: string;
  create(): T;
}

type SubsystemEntry = {
  name: string;
  value: unknown;
  hooks: SubsystemHooks<unknown>;
};

export class SubsystemRegistry {
  private readonly entries: SubsystemEntry[] = [];

  register<T>(definition: SubsystemDefinition<T>): T {
    const { name } = definition;
    if (this.entries.some((entry) => entry.name === name)) {
      throw new Error(`Subsystem "${name}" has already been registered.`);
    }
    const value = definition.create();
    this.entries.push({ name, value, hooks: definition as SubsystemHooks<unknown> });
    return value;
  }

  async start(): Promise<void> {
    for (const entry of this.entries) {
      await entry.hooks.start?.(entry.value);
    }
  }

  async activate(): Promise<void> {
    for (const entry of this.entries) {
      await entry.hooks.activate?.(entry.value);
    }
  }

  suspend(): unknown[] {
    const errors: unknown[] = [];
    for (const entry of this.entries.toReversed()) {
      try {
        entry.hooks.suspend?.(entry.value);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  async deactivate(): Promise<unknown[]> {
    return await this.runCleanup('deactivate');
  }

  async stop(): Promise<unknown[]> {
    return await this.runCleanup('stop');
  }

  private async runCleanup(hook: 'deactivate' | 'stop'): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const entry of this.entries.toReversed()) {
      try {
        const result = await entry.hooks[hook]?.(entry.value);
        if (result) {
          errors.push(...result);
        }
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }
}
