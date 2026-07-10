import type { Logger } from '../logging';
import type { ContextState } from './lifecycle';

export class TimerRegistry {
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly contextName: string,
    private readonly logger: Logger,
    private readonly getState: () => ContextState,
  ) {}

  get hasTimers(): boolean {
    return this.timers.size > 0;
  }

  timeout(delayMs: number, callback: () => void | Promise<void>): NodeJS.Timeout {
    this.assertCanScheduleTimer();
    const timeout = setTimeout(() => {
      this.timers.delete(timeout);
      void this.runTimerCallback(callback);
    }, delayMs);
    this.timers.add(timeout);
    return timeout;
  }

  interval(intervalMs: number, callback: () => void | Promise<void>): NodeJS.Timeout {
    this.assertCanScheduleTimer();
    const interval = setInterval(() => {
      void this.runTimerCallback(callback);
    }, intervalMs);
    this.timers.add(interval);
    return interval;
  }

  clear(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private assertCanScheduleTimer(): void {
    const state = this.getState();
    if (state === 'stopping') {
      throw new Error(`Context "${this.contextName}" cannot schedule timers while it is stopping.`);
    }
    if (state === 'stopped') {
      throw new Error(`Context "${this.contextName}" cannot schedule timers after it has stopped.`);
    }
  }

  private async runTimerCallback(callback: () => void | Promise<void>): Promise<void> {
    const state = this.getState();
    if (state === 'stopping' || state === 'stopped') {
      return;
    }
    try {
      await callback();
    } catch (error) {
      this.logger.error('Error handling timer callback', error);
    }
  }
}
