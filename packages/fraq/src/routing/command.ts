/** biome-ignore-all lint/suspicious/noExplicitAny: This file is meant to be used by users of the library, so we want to allow any types for flexibility. */
/** biome-ignore-all lint/complexity/noBannedTypes: {} is used in CommandBuilder to allow flexible pattern definitions. */
import type * as types from '../protocol/types';
import type { Parameter } from './parameter';

export type Pattern = Record<string, Parameter<any>>;
export type ParamsOf<P extends Pattern> = { [K in keyof P]: P[K] extends Parameter<infer T> ? T : never };
export type Executor<P extends Pattern> = (session: Session, params: ParamsOf<P>) => void | Promise<void>;
export type RouteMeta = Record<string, unknown> & {
  tags?: readonly string[];
};

export interface Command<P extends Pattern> {
  name: string;
  pattern: P;
  execute: Executor<P>;
  description?: string;
  aliases?: string[];
  hidden?: boolean;
  meta?: RouteMeta;
}

export interface RawPattern<P extends Pattern> {
  pattern: P;
  execute: Executor<P>;
  meta?: RouteMeta;
}

export interface SessionReplyOptions {
  withQuote?: boolean;
  withMention?: boolean;
}

export interface Session {
  selfId: number;
  raw: types.IncomingMessage;
  reply(
    textOrSegments: string | types.OutgoingSegment_ZodInput[],
    options?: SessionReplyOptions,
  ): Promise<{ messageSeq: number }>;
  reaction(type: 'face' | 'emoji', reactionId: string): Promise<void>;
}

export class CommandBuilder<P extends Pattern = {}, S = Command<P>> {
  private readonly pattern: Record<string, Parameter<any>> = {};
  private executor?: Executor<P>;
  private description?: string;
  private aliases?: string[];
  private hidden?: boolean;
  private routeMeta?: RouteMeta;

  constructor(
    readonly name: string,
    private readonly sink: (command: Command<P>) => S = (command) => command as S,
  ) {}

  arg<K extends string, T>(key: K, parameter: Parameter<T>) {
    this.pattern[key] = parameter;
    return this as CommandBuilder<
      P & { [K2 in K]: Parameter<T> },
      S extends Command<P>
        ? Command<P & { [K2 in K]: Parameter<T> }>
        : S extends RawPattern<P>
          ? RawPattern<P & { [K2 in K]: Parameter<T> }>
          : S
    >;
  }

  describe(description: string) {
    this.description = description;
    return this as CommandBuilder<P, S>;
  }

  alias(...aliases: string[]) {
    if (!this.aliases) {
      this.aliases = [];
    }
    this.aliases.push(...aliases);
    return this as CommandBuilder<P, S>;
  }

  hide() {
    this.hidden = true;
    return this as CommandBuilder<P, S>;
  }

  meta(meta: RouteMeta) {
    this.routeMeta = mergeRouteMeta(this.routeMeta, meta);
    return this as CommandBuilder<P, S>;
  }

  tag(...tags: string[]) {
    this.routeMeta = mergeRouteMeta(this.routeMeta, { tags });
    return this as CommandBuilder<P, S>;
  }

  execute(executor: Executor<P>): S {
    this.executor = executor;
    const command: Command<P> = {
      name: this.name,
      pattern: this.pattern as P,
      execute: this.executor,
    };
    if (this.description !== undefined) {
      command.description = this.description;
    }
    if (this.aliases !== undefined) {
      command.aliases = this.aliases;
    }
    if (this.hidden !== undefined) {
      command.hidden = this.hidden;
    }
    if (this.routeMeta !== undefined) {
      command.meta = this.routeMeta;
    }
    return this.sink(command);
  }
}

export function mergeRouteMeta(left?: RouteMeta, right?: RouteMeta): RouteMeta | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }

  const merged = {
    ...(left ?? {}),
    ...(right ?? {}),
  } as RouteMeta;

  const tags = uniqueTags(left?.tags, right?.tags);
  if (tags.length > 0) {
    merged.tags = tags;
  } else {
    delete merged.tags;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function uniqueTags(...tagLists: Array<readonly string[] | undefined>): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const tagList of tagLists) {
    for (const tag of tagList ?? []) {
      if (seen.has(tag)) {
        continue;
      }
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}
