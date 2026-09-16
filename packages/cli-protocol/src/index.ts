export const PROTOCOL_VERSION = 1;
export const MAX_LOG_LINES = 1_000;
export const MAX_LOG_BYTES = 4 * 1024 * 1024;
export const MAX_LOG_LINE_BYTES = 16 * 1024;
export const MAX_LOG_BATCH_BYTES = 256 * 1024;
export const MAX_CONFIG_BYTES = 1024 * 1024;
export const MAX_CONFIG_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_CONFIG_FILES = 128;
export const REQUEST_TIMEOUT_MS = 10_000;
export const LOG_POLL_MS = 250;

export type ErrorCode = 'invalid' | 'conflict' | 'busy' | 'unavailable' | 'timeout' | 'internal';

export class ControlError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ConfigDocument {
  name: string;
  format: 'yaml' | 'json';
  content: string;
  revision: string;
}

export type ConfigFile = {
  id: string;
  name: string;
  format: 'yaml' | 'json' | 'text';
  main: boolean;
} & ({ editable: true; content: string } | { editable: false; reason: string });

export interface ConfigWorkspace {
  root: string;
  revision: string;
  files: ConfigFile[];
  error?: string;
}

export interface ConfigChanges {
  revision: string;
  files: { id: string; content: string }[];
}

export interface AppStatus {
  session: string;
  state: 'starting' | 'running' | 'restarting' | 'stopped';
  fallback: boolean;
  error: string | null;
  generation: number;
  busy: boolean;
}

export interface LogEntry {
  session: string;
  sequence: number;
  time: number;
  source: 'cli' | 'app' | 'install';
  stream: 'stdout' | 'stderr';
  text: string;
  bytes: number;
  truncated: boolean;
}

export interface LogCursor {
  session?: string;
  after?: number;
}

export interface LogBatch {
  session: string;
  entries: LogEntry[];
  cursor: number;
  gap: boolean;
}

export interface Methods {
  hello: { input: undefined; output: { version: number; capabilities: string[] } };
  status: { input: undefined; output: AppStatus };
  config: { input: undefined; output: ConfigDocument };
  save: { input: { content: string; revision: string }; output: ConfigDocument };
  configFiles: { input: undefined; output: ConfigWorkspace };
  saveFiles: { input: ConfigChanges; output: ConfigWorkspace };
  restart: { input: undefined; output: { accepted: true } };
  logs: { input: LogCursor; output: LogBatch };
}

export type Method = keyof Methods;

export type ControlRequest = {
  [M in Method]: {
    type: 'fraq:control:request';
    version: 1;
    id: string;
    method: M;
    input: Methods[M]['input'];
  };
}[Method];

export interface ControlResponse {
  type: 'fraq:control:response';
  version: 1;
  id: string;
  result?: unknown;
  error?: { code: ErrorCode; message: string };
}

export interface ControlClient {
  request<M extends Method>(method: M, input: Methods[M]['input']): Promise<Methods[M]['output']>;
}
