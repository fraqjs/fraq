import type { Event } from './types';

export interface MilkyEventSubscription {
  closed: Promise<void>;
  stop(): void | Promise<void>;
}

export interface MilkyEventSource {
  readonly name?: string;
  start(onEvent: (event: Event) => void | Promise<void>): Promise<MilkyEventSubscription>;
}

export interface MilkyWebSocketEventSourceOptions {
  accessToken?: string;
}

export function createMilkyWebSocketEventSource(
  baseUrl: string | URL,
  options?: MilkyWebSocketEventSourceOptions,
): MilkyEventSource {
  const normalizedBaseUrl = baseUrl.toString();
  const wsBaseUrl = normalizedBaseUrl.endsWith('/')
    ? normalizedBaseUrl.slice(0, -1).replace(/^http/, 'ws')
    : normalizedBaseUrl.replace(/^http/, 'ws');

  return {
    name: 'websocket',
    async start(onEvent: (event: Event) => void | Promise<void>): Promise<MilkyEventSubscription> {
      const ws = new WebSocket(
        `${wsBaseUrl}/event${options?.accessToken ? `?access_token=${options.accessToken}` : ''}`,
      );
      let closeSubscription: (error?: unknown) => void = () => {};
      const closed = new Promise<void>((resolve, reject) => {
        closeSubscription = (error?: unknown) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };
      });

      ws.addEventListener('message', async (event) => {
        try {
          if (typeof event.data !== 'string') {
            throw new Error(`Expected text frame, got ${typeof event.data}`);
          }
          await onEvent(JSON.parse(event.data) as Event);
        } catch (error) {
          closeSubscription(error);
          ws.close();
        }
      });

      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true });
        ws.addEventListener('error', (event) => reject(new Error(`WebSocket error: ${event}`)));
      });

      ws.addEventListener('error', (event) => closeSubscription(new Error(`WebSocket error: ${event}`)));
      ws.addEventListener('close', () => closeSubscription(), { once: true });

      return {
        closed,
        stop() {
          ws.close();
        },
      };
    },
  };
}
