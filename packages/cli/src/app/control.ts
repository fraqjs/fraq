import {
  type AppStatus,
  ControlError,
  type ControlRequest,
  type ControlResponse,
  MAX_LOG_BATCH_BYTES,
  PROTOCOL_VERSION,
} from '@fraqjs/cli-protocol';

import type { ConfigEditor } from '../config/editor';
import type { LogRegistry } from './logs';

export class CliControl {
  private closed = false;

  constructor(
    private readonly logs: LogRegistry,
    private readonly getStatus: () => AppStatus,
    private readonly restart: () => void,
    private readonly editor: ConfigEditor,
  ) {}

  close(): void {
    this.closed = true;
  }

  async handle(request: ControlRequest): Promise<ControlResponse> {
    const response: ControlResponse = { type: 'fraq:control:response', version: PROTOCOL_VERSION, id: request.id };
    try {
      if (this.closed) throw new ControlError('unavailable', 'CLI 会话正在退出。');
      switch (request.method) {
        case 'hello':
          response.result = { version: PROTOCOL_VERSION, capabilities: ['config', 'config-files', 'restart', 'logs'] };
          break;
        case 'status':
          response.result = this.getStatus();
          break;
        case 'config':
          response.result = this.editor.read();
          break;
        case 'configFiles':
          response.result = this.editor.list();
          break;
        case 'saveFiles':
          if (this.getStatus().busy) throw new ControlError('busy', '正在应用配置，请稍后保存。');
          response.result = this.editor.saveFiles(request.input);
          this.logs.message('Configuration files saved from WebUI; waiting for the watcher to apply them.');
          break;
        case 'logs':
          response.result = this.logs.read(request.input, MAX_LOG_BATCH_BYTES);
          break;
        case 'save':
          if (this.getStatus().busy) throw new ControlError('busy', '正在应用配置，请稍后保存。');
          response.result = this.editor.save(request.input.content, request.input.revision);
          this.logs.message('Configuration saved from WebUI; waiting for the watcher to apply it.');
          break;
        case 'restart':
          this.restart();
          response.result = { accepted: true };
          break;
      }
    } catch (error) {
      response.error = {
        code: error instanceof ControlError ? error.code : 'internal',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    return response;
  }
}
