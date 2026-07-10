import type { ApiHookRegistry } from './api-hooks';
import type { EventSourceRegistry } from './event-sources';
import type { InstalledPlugin, PluginRegistry } from './plugins';
import type { TimerRegistry } from './timers';

export type ContextState = 'idle' | 'starting' | 'started' | 'stopping' | 'stopped';

type AppliedContextPlugins = {
  lifecycle: LifecycleManager;
  sortedPlugins: InstalledPlugin[];
};

export class LifecycleManager {
  private readonly children = new Set<LifecycleManager>();
  private currentState: ContextState = 'idle';
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;

  constructor(
    private readonly contextName: string,
    private readonly plugins: PluginRegistry,
    private readonly timers: TimerRegistry,
    private readonly eventSources: EventSourceRegistry,
    private readonly apiHooks: ApiHookRegistry,
    private readonly detachParentEvents: () => void,
  ) {}

  get state(): ContextState {
    return this.currentState;
  }

  addChild(child: LifecycleManager): void {
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
    if ((this.currentState === 'idle' && !this.timers.hasTimers) || this.currentState === 'stopped') {
      return;
    }
    let stateAfterStart: ContextState = this.currentState;
    if (stateAfterStart === 'starting') {
      await this.startPromise;
      // The awaited start or another stop call may have changed the state.
      stateAfterStart = this.currentState as ContextState;
    }
    if ((stateAfterStart === 'idle' && !this.timers.hasTimers) || stateAfterStart === 'stopped') {
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
    const appliedContextPlugins: AppliedContextPlugins[] = [];
    const startingContexts: LifecycleManager[] = [];
    try {
      await this.recursiveApplyPlugins(appliedContextPlugins, startingContexts);
      for (const { lifecycle, sortedPlugins } of appliedContextPlugins) {
        await lifecycle.plugins.start(sortedPlugins);
      }
    } catch (error) {
      for (const lifecycle of startingContexts) {
        if (lifecycle.currentState === 'starting') {
          lifecycle.currentState = 'idle';
        }
      }
      throw error;
    }
    for (const { lifecycle } of appliedContextPlugins) {
      lifecycle.currentState = 'started';
      lifecycle.eventSources.startAll();
    }
  }

  private async stopInternal(): Promise<void> {
    const errors: unknown[] = [];

    this.timers.clear();

    for (const child of [...this.children].reverse()) {
      try {
        await child.stop();
      } catch (error) {
        errors.push(error);
      }
    }

    errors.push(...(await this.eventSources.stop()));
    this.detachParentEvents();
    errors.push(...(await this.plugins.disposeServices()));
    this.apiHooks.clear();

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, `Context "${this.contextName}" failed to stop cleanly.`);
    }
  }

  private async recursiveApplyPlugins(
    appliedContextPlugins: AppliedContextPlugins[],
    startingContexts: LifecycleManager[],
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

    const sortedPlugins = await this.plugins.apply();
    appliedContextPlugins.push({ lifecycle: this, sortedPlugins });

    for (const child of this.children) {
      await child.recursiveApplyPlugins(appliedContextPlugins, startingContexts);
    }
  }
}
