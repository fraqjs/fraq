import { constants as osConstants } from 'node:os';

const terminationSignals: readonly NodeJS.Signals[] =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

export class SignalRegistry {
  private readonly handlers = new Map<NodeJS.Signals, () => void>();
  private received?: NodeJS.Signals;
  private resolveExit!: (code: number) => void;
  readonly exit = new Promise<number>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(
    private readonly onSignal: (signal: NodeJS.Signals) => void,
    private readonly target: {
      on(signal: NodeJS.Signals, handler: () => void): unknown;
      off(signal: NodeJS.Signals, handler: () => void): unknown;
    } = process,
  ) {}

  get exitCode(): number | undefined {
    return this.received === undefined ? undefined : 128 + (osConstants.signals[this.received] ?? 1);
  }

  start(): void {
    if (this.handlers.size) return;
    for (const signal of terminationSignals) {
      const handler = () => {
        const forwarded = this.received === undefined ? signal : 'SIGKILL';
        this.received ??= signal;
        this.resolveExit(this.exitCode ?? 1);
        this.onSignal(forwarded);
      };
      this.handlers.set(signal, handler);
      this.target.on(signal, handler);
    }
  }

  close(): void {
    for (const [signal, handler] of this.handlers) this.target.off(signal, handler);
    this.handlers.clear();
  }
}
