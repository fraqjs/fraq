import type { InstalledPlugin, PluginRegistry } from './plugins';
import type { ServiceRegistry } from './services';
import type { SubsystemRegistry } from './subsystems';

export type ContextState = 'idle' | 'starting' | 'started' | 'stopping' | 'stopped';

type AppliedContextPlugins<C extends object> = {
  lifecycle: LifecycleManager<C>;
  sortedPlugins: InstalledPlugin<C>[];
};

export class LifecycleManager<C extends object> {
  private readonly children = new Set<LifecycleManager<C>>();
  private currentState: ContextState = 'idle';
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;

  constructor(
    private readonly contextName: string,
    private readonly plugins: PluginRegistry<C>,
    private readonly services: ServiceRegistry<C>,
    private readonly subsystems: SubsystemRegistry,
    private readonly unwire: () => void | Promise<void>,
  ) {}

  get state(): ContextState {
    return this.currentState;
  }

  addChild(child: LifecycleManager<C>): void {
    this.children.add(child);
  }

  async start(): Promise<void> {
    if (this.currentState === 'started') {
      return;
    }
    if (this.currentState === 'starting') {
      await this.startPromise;
      return;
    }
    if (this.currentState === 'stopping') {
      throw new Error(`Context "${this.contextName}" cannot be started while it is stopping.`);
    }
    if (this.currentState === 'stopped') {
      throw new Error(`Context "${this.contextName}" cannot be restarted after it has been stopped.`);
    }

    this.currentState = 'starting';
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.currentState === 'stopped') {
      return;
    }
    let stateAfterStart: ContextState = this.currentState;
    if (stateAfterStart === 'starting') {
      await this.startPromise;
      stateAfterStart = this.currentState as ContextState;
    }
    if (stateAfterStart === 'stopped') {
      return;
    }
    if (stateAfterStart === 'stopping') {
      await this.stopPromise;
      return;
    }

    this.currentState = 'stopping';
    this.stopPromise = this.stopInternal();
    try {
      await this.stopPromise;
    } finally {
      this.currentState = 'stopped';
      this.stopPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    const appliedContextPlugins: AppliedContextPlugins<C>[] = [];
    const startingContexts: LifecycleManager<C>[] = [];
    try {
      await this.recursiveApplyPlugins(appliedContextPlugins, startingContexts);
      for (const { lifecycle, sortedPlugins } of appliedContextPlugins) {
        await lifecycle.plugins.start(sortedPlugins);
      }
      for (const { lifecycle } of appliedContextPlugins) {
        lifecycle.currentState = 'started';
        await lifecycle.subsystems.activate();
      }
    } catch (error) {
      for (const lifecycle of startingContexts) {
        if (lifecycle.currentState === 'starting' || lifecycle.currentState === 'started') {
          lifecycle.currentState = 'idle';
        }
      }
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    const errors = this.subsystems.suspend();

    for (const child of [...this.children].reverse()) {
      try {
        await child.stop();
      } catch (error) {
        errors.push(error);
      }
    }

    errors.push(...(await this.subsystems.deactivate()));
    try {
      await this.unwire();
    } catch (error) {
      errors.push(error);
    }
    errors.push(...(await this.services.dispose()));
    errors.push(...(await this.subsystems.stop()));

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, `Context "${this.contextName}" failed to stop cleanly.`);
    }
  }

  private async recursiveApplyPlugins(
    appliedContextPlugins: AppliedContextPlugins<C>[],
    startingContexts: LifecycleManager<C>[],
  ): Promise<void> {
    if (this.currentState === 'started') {
      return;
    }
    if (this.currentState === 'starting' && this.startPromise) {
      await this.startPromise;
      return;
    }
    if (this.currentState === 'stopping') {
      throw new Error(`Context "${this.contextName}" cannot be started while it is stopping.`);
    }
    if (this.currentState === 'stopped') {
      throw new Error(`Context "${this.contextName}" cannot be restarted after it has been stopped.`);
    }
    if (this.currentState === 'idle') {
      this.currentState = 'starting';
    }
    startingContexts.push(this);

    await this.subsystems.start();
    const sortedPlugins = await this.plugins.apply();
    appliedContextPlugins.push({ lifecycle: this, sortedPlugins });

    for (const child of this.children) {
      await child.recursiveApplyPlugins(appliedContextPlugins, startingContexts);
    }
  }
}
