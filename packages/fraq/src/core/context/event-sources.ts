import type { ContextState } from '@fraqjs/kernel';

import type { MilkyEventSource, MilkyEventSubscription } from '../../protocol/event';
import type { Event } from '../../protocol/types';
import type { Logger } from '../logging';

export interface ReconnectOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;

type EventSourceRuntime = {
  subscription?: MilkyEventSubscription;
  task?: Promise<void>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  resolveReconnectTimer?: () => void;
};

export class EventSourceRegistry {
  private readonly runtimes = new Map<MilkyEventSource, EventSourceRuntime>();
  private readonly initialReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;

  constructor(
    options: ReconnectOptions | undefined,
    private readonly logger: Logger,
    private readonly getState: () => ContextState,
    private readonly emit: (event: Event) => void,
  ) {
    this.initialReconnectDelayMs = options?.initialDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
  }

  install(eventSource: MilkyEventSource): void {
    if (this.runtimes.has(eventSource)) {
      return;
    }
    const runtime: EventSourceRuntime = {};
    this.runtimes.set(eventSource, runtime);
    if (this.getState() === 'started') {
      runtime.task = this.runEventSource(eventSource, runtime);
    }
  }

  startAll(): void {
    for (const [eventSource, runtime] of this.runtimes) {
      runtime.task = this.runEventSource(eventSource, runtime);
    }
  }

  async stop(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const runtime of this.runtimes.values()) {
      this.resolveReconnectDelay(runtime);
      const subscription = runtime.subscription;
      if (!subscription) {
        continue;
      }
      try {
        await subscription.stop();
      } catch (error) {
        errors.push(error);
      }
      runtime.subscription = undefined;
    }
    for (const runtime of this.runtimes.values()) {
      if (!runtime.task) {
        continue;
      }
      try {
        await runtime.task;
      } catch (error) {
        errors.push(error);
      } finally {
        runtime.task = undefined;
      }
    }
    return errors;
  }

  private async runEventSource(eventSource: MilkyEventSource, runtime: EventSourceRuntime): Promise<void> {
    let reconnectDelay = this.initialReconnectDelayMs;
    let reconnectAttempt = 1;
    while (this.getState() === 'started') {
      try {
        this.logger.debug(`Connecting ${eventSource.name ?? 'event source'} (attempt=${reconnectAttempt})`);
        const subscription = await eventSource.start((event: Event) => {
          try {
            if (this.getState() !== 'started') {
              return;
            }
            this.emit(event);
          } catch (error) {
            this.logger.error('Error handling event stream event', error);
          }
        });
        if (this.getState() !== 'started') {
          await subscription.stop();
          break;
        }
        runtime.subscription = subscription;
        this.logger.info(`${eventSource.name ?? 'Event source'} connected`);
        reconnectDelay = this.initialReconnectDelayMs;
        reconnectAttempt = 1;
        await subscription.closed;
        if (runtime.subscription === subscription) {
          runtime.subscription = undefined;
        }
        if (this.getState() !== 'started') {
          break;
        }
        this.logger.warn(`${eventSource.name ?? 'Event source'} disconnected; reconnecting in ${reconnectDelay}ms`);
      } catch (error) {
        if (this.getState() !== 'started') {
          break;
        }
        this.logger.error(
          `Error connecting ${eventSource.name ?? 'event source'}; reconnecting in ${reconnectDelay}ms`,
          error,
        );
      }
      await this.waitForReconnectDelay(runtime, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, this.maxReconnectDelayMs);
      reconnectAttempt += 1;
    }
  }

  private waitForReconnectDelay(runtime: EventSourceRuntime, delay: number): Promise<void> {
    return new Promise((resolve) => {
      runtime.resolveReconnectTimer = resolve;
      runtime.reconnectTimer = setTimeout(() => {
        runtime.reconnectTimer = undefined;
        runtime.resolveReconnectTimer = undefined;
        resolve();
      }, delay);
    });
  }

  private resolveReconnectDelay(runtime: EventSourceRuntime): void {
    if (runtime.reconnectTimer) {
      clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = undefined;
    }
    const resolve = runtime.resolveReconnectTimer;
    runtime.resolveReconnectTimer = undefined;
    resolve?.();
  }
}
