import {
  type ControlClient,
  ControlError,
  type ControlResponse,
  type Method,
  type Methods,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
} from '@fraqjs/cli-protocol';

import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';

export interface IpcTransport extends EventEmitter {
  connected?: boolean;
  send?: (message: object, callback: (error: Error | null) => void) => boolean;
}

export class CliClient implements ControlClient {
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  private closed = false;
  private readonly onMessage = (value: unknown) => {
    const response = value as ControlResponse;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.version !== PROTOCOL_VERSION) pending.reject(new ControlError('unavailable', 'CLI 协议版本不兼容。'));
    else if (response.error) pending.reject(new ControlError(response.error.code, response.error.message));
    else pending.resolve(response.result);
  };
  private readonly onDisconnect = () => this.dispose();

  constructor(
    private readonly transport: IpcTransport = process,
    private readonly timeout = REQUEST_TIMEOUT_MS,
  ) {
    transport.on('message', this.onMessage);
    transport.on('disconnect', this.onDisconnect);
  }

  request<M extends Method>(method: M, input: Methods[M]['input']): Promise<Methods[M]['output']> {
    if (this.closed || !this.transport.connected || !this.transport.send) {
      return Promise.reject(new ControlError('unavailable', 'CLI 连接已断开。'));
    }
    if (this.pending.size >= 32) return Promise.reject(new ControlError('busy', 'CLI 请求过多，请稍后重试。'));
    const id = randomUUID();
    return new Promise<Methods[M]['output']>((resolve, reject) => {
      const fail = (error: Error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      };
      const timer = setTimeout(() => fail(new ControlError('timeout', 'CLI 请求超时。')), this.timeout);
      this.pending.set(id, { resolve: (value) => resolve(value as Methods[M]['output']), reject, timer });
      try {
        this.transport.send?.(
          { type: 'fraq:control:request', version: PROTOCOL_VERSION, id, method, input },
          (error) => {
            if (error) fail(new ControlError('unavailable', '无法连接 CLI。'));
          },
        );
      } catch {
        fail(new ControlError('unavailable', '无法连接 CLI。'));
      }
    });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.off('message', this.onMessage);
    this.transport.off('disconnect', this.onDisconnect);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ControlError('unavailable', 'CLI 连接已断开。'));
    }
    this.pending.clear();
  }
}
