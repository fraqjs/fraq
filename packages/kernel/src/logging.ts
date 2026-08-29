import mitt, { type Emitter } from 'mitt';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogMessage {
  level: LogLevel;
  module: string;
  message: string;
  error?: unknown;
  time: number;
}

export type LogHandler = (message: LogMessage) => void;

export interface LogEvents {
  [key: string]: LogMessage;
  [key: symbol]: LogMessage;
  log: LogMessage;
}

/** The subscription-only view of a context's log event emitter. */
export interface LogEmitter {
  on(type: 'log', handler: LogHandler): void;
  off(type: 'log', handler?: LogHandler): void;
}

export function createLogEmitter(): Emitter<LogEvents> {
  return mitt<LogEvents>();
}

export class Logger {
  constructor(
    private readonly logHandler: LogHandler,
    private readonly module: string,
  ) {}

  private log(level: LogLevel, message: string, error?: unknown) {
    this.logHandler({
      level,
      module: this.module,
      message,
      error,
      time: Date.now(),
    });
  }

  debug(message: string) {
    this.log('debug', message);
  }

  info(message: string) {
    this.log('info', message);
  }

  warn(message: string, error?: unknown) {
    this.log('warn', message, error);
  }

  error(message: string, error?: unknown) {
    this.log('error', message, error);
  }
}

/** @deprecated Call `ctx.logBus.on('log', handler)` for multiple subscribers instead. */
export function combineLogHandlers(...handlers: LogHandler[]): LogHandler {
  return (message) => {
    for (const handler of handlers) {
      handler(message);
    }
  };
}
