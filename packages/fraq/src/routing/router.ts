/** biome-ignore-all lint/suspicious/noExplicitAny: This file is meant to be used by users of the library, so we want to allow any types for flexibility. */
/** biome-ignore-all lint/complexity/noBannedTypes: {} is used in CommandBuilder to allow flexible pattern definitions. */
import type * as types from '../protocol/types';
import {
  type Command,
  CommandBuilder,
  mergeRouteMeta,
  type ParamsOf,
  type Pattern,
  type RawPattern,
  type RouteMeta,
  type Session,
} from './command';
import { Tokenizer } from './tokenizer';

export type SessionPredicate = (session: Session) => boolean;

export type RouteActivation =
  | { type: 'direct' }
  | { type: 'mention'; prefix?: string }
  | { type: 'prefix'; prefix: string };
export type RouteActivationInput = RouteActivation | readonly RouteActivation[];

export type RouteDescriptor =
  | { type: 'command'; path: readonly string[]; name: string; aliases?: readonly string[]; meta?: RouteMeta }
  | { type: 'rawPattern'; path: readonly string[]; meta?: RouteMeta };

export type RouteActivationResolver = (route: RouteDescriptor, session: Session) => RouteActivationInput | undefined;

const DEFAULT_ACTIVATIONS: readonly RouteActivation[] = [{ type: 'direct' }];

export const defaultRouteActivationResolver: RouteActivationResolver = () => DEFAULT_ACTIVATIONS;

export type RouteEntry =
  | { type: 'command'; command: Command<Pattern> }
  | { type: 'group'; name: string; router: Router }
  | { type: 'filter'; predicate: SessionPredicate; router: Router }
  | { type: 'rawPattern'; rawPattern: RawPattern<Pattern> };

export type RouteBranch =
  | { type: 'command'; path: string[]; command: Command<Pattern>; meta?: RouteMeta }
  | { type: 'rawPattern'; path: string[]; rawPattern: RawPattern<Pattern>; meta?: RouteMeta };

export type RouteMatchResult =
  | { type: 'command'; path: string[]; command: Command<Pattern>; params: any; activation?: RouteActivation }
  | { type: 'rawPattern'; path: string[]; rawPattern: RawPattern<Pattern>; params: any; activation?: RouteActivation };

export class Router {
  private entries: RouteEntry[] = [];
  private groups = new Map<string, Router>();
  private activationResolver: RouteActivationResolver = defaultRouteActivationResolver;
  private scopeMeta?: RouteMeta;

  setActivationResolver(resolver: RouteActivationResolver): this {
    this.activationResolver = resolver;
    return this;
  }

  withMeta(meta: RouteMeta): Router {
    const router = new Router();
    router.entries = this.entries;
    router.groups = this.groups;
    router.scopeMeta = mergeRouteMeta(this.scopeMeta, meta);
    return router;
  }

  command(name: string): CommandBuilder;
  command<P extends Pattern>(command: Command<P>): this;
  command<P extends Pattern>(command: string | Command<P>): CommandBuilder | this {
    if (typeof command === 'string') {
      return new CommandBuilder(command, (builtCommand): Command<{}> => {
        this.command(builtCommand);
        return builtCommand;
      });
    }
    const scopedCommand = this.applyScopeMeta(command);
    this.validatePattern(scopedCommand.pattern);
    this.resolveAliasConflicts(scopedCommand);
    // @ts-expect-error
    this.entries.push({ type: 'command', command: scopedCommand });
    return this;
  }

  rawPattern(): CommandBuilder<{}, RawPattern<{}>>;
  rawPattern<P extends Pattern>(rawPattern: RawPattern<P>): this;
  rawPattern<P extends Pattern>(rawPattern?: RawPattern<P>): CommandBuilder<{}, RawPattern<{}>> | this {
    if (!rawPattern) {
      return new CommandBuilder('', (builtCommand): RawPattern<{}> => {
        // Command extends RawPattern, so compatible to provide a "command" here
        this.rawPattern(builtCommand);
        return builtCommand;
      });
    }
    const scopedRawPattern = this.applyScopeMeta(rawPattern);
    this.validatePattern(scopedRawPattern.pattern, { rawPattern: true });
    // @ts-expect-error
    this.entries.push({ type: 'rawPattern', rawPattern: scopedRawPattern });
    return this;
  }

  group(name: string): Router {
    let router = this.groups.get(name);
    if (!router) {
      router = new Router();
      this.groups.set(name, router);
      this.entries.push({ type: 'group', name, router });
    }
    return this.scopeMeta ? router.withMeta(this.scopeMeta) : router;
  }

  filter(predicate: SessionPredicate): Router {
    const router = new Router();
    this.entries.push({ type: 'filter', predicate: predicate, router });
    return this.scopeMeta ? router.withMeta(this.scopeMeta) : router;
  }

  routes(): RouteEntry[] {
    return this.entries;
  }

  aliasesOf(name: string): string[] {
    for (const entry of this.entries) {
      if (entry.type === 'command' && entry.command.name === name) {
        return entry.command.aliases ? [...entry.command.aliases] : [];
      }
    }
    return [];
  }

  branches(session: Session): RouteBranch[] {
    return [...this.branchesFrom(session, [], { includeHidden: false })];
  }

  match(session: Session, message: types.IncomingMessage): RouteMatchResult | undefined {
    for (const branch of this.branchesFrom(session, [], { includeHidden: true })) {
      const literalActivationIndex =
        branch.type === 'rawPattern'
          ? Object.values(branch.rawPattern.pattern).findIndex(
              (parameter) => parameter.capturer.typeInstruction.type === 'literal',
            )
          : -1;
      let activationInputs: readonly RouteActivation[] = DEFAULT_ACTIVATIONS;
      if (branch.type === 'command' || literalActivationIndex !== -1) {
        const descriptor = this.describeBranch(branch);
        const activations = this.activationResolver(descriptor, session) ?? DEFAULT_ACTIVATIONS;
        activationInputs = Array.isArray(activations) ? activations : [activations as RouteActivation];
      }

      for (const activation of activationInputs) {
        const tokenizer = new Tokenizer(message.segments);
        const match = this.matchBranch(branch, tokenizer, activation, session, literalActivationIndex);
        if (match !== undefined) {
          return match;
        }
      }
    }

    return undefined;
  }

  async dispatch(session: Session, message: types.IncomingMessage): Promise<boolean> {
    const match = this.match(session, message);
    if (match === undefined) {
      return false;
    }
    switch (match.type) {
      case 'command':
        await match.command.execute(session, match.params);
        break;
      case 'rawPattern':
        await match.rawPattern.execute(session, match.params);
        break;
    }
    return true;
  }

  private describeBranch(branch: RouteBranch): RouteDescriptor {
    switch (branch.type) {
      case 'command': {
        const descriptor: RouteDescriptor = {
          type: 'command',
          path: [...branch.path],
          name: branch.command.name,
        };
        if (branch.command.aliases !== undefined) {
          descriptor.aliases = [...branch.command.aliases];
        }
        if (branch.command.meta !== undefined) {
          descriptor.meta = branch.command.meta;
        }
        return descriptor;
      }
      case 'rawPattern': {
        const descriptor: RouteDescriptor = {
          type: 'rawPattern',
          path: [...branch.path],
        };
        if (branch.rawPattern.meta !== undefined) {
          descriptor.meta = branch.rawPattern.meta;
        }
        return descriptor;
      }
    }
  }

  private consumeActivation(tokenizer: Tokenizer, activation: RouteActivation, session: Session): boolean {
    switch (activation.type) {
      case 'direct':
        return true;
      case 'mention': {
        if (!tokenizer.consumeMention(session.selfId)) {
          return false;
        }
        return activation.prefix === undefined || tokenizer.consumeTextPrefix(activation.prefix);
      }
      case 'prefix':
        return tokenizer.consumeTextPrefix(activation.prefix);
    }
  }

  private matchBranch(
    branch: RouteBranch,
    tokenizer: Tokenizer,
    activation: RouteActivation,
    session: Session,
    literalActivationIndex: number,
  ): RouteMatchResult | undefined {
    if (branch.type === 'command' && !this.consumeActivation(tokenizer, activation, session)) {
      return undefined;
    }

    if (!this.matchPath(branch.path, tokenizer)) {
      return undefined;
    }

    switch (branch.type) {
      case 'command':
        return this.matchCommand(branch.command, tokenizer, branch.path, activation);
      case 'rawPattern':
        return this.matchRawPattern(
          branch.rawPattern,
          tokenizer,
          branch.path,
          activation,
          session,
          literalActivationIndex,
        );
    }
  }

  private matchPath(path: string[], tokenizer: Tokenizer): boolean {
    for (const name of path) {
      const token = tokenizer.peek();
      if (typeof token !== 'string' || token !== name) {
        return false;
      }
      tokenizer.next();
    }

    return true;
  }

  private matchCommand(
    command: Command<Pattern>,
    tokenizer: Tokenizer,
    path: string[],
    activation: RouteActivation,
  ): RouteMatchResult | undefined {
    const token = tokenizer.peek();
    if (typeof token !== 'string' || (token !== command.name && !command.aliases?.includes(token))) {
      return undefined;
    }

    tokenizer.next();
    const params = this.capturePattern(command.pattern, tokenizer);
    if (params === undefined || tokenizer.hasNext()) {
      return undefined;
    }

    return { type: 'command', path: [...path], command, params, activation };
  }

  private matchRawPattern(
    rawPattern: RawPattern<Pattern>,
    tokenizer: Tokenizer,
    path: string[],
    activation: RouteActivation,
    session: Session,
    literalActivationIndex: number,
  ): RouteMatchResult | undefined {
    const params = {} as ParamsOf<Pattern>;

    for (const [index, [name, parameter]] of Object.entries(rawPattern.pattern).entries()) {
      if (index === literalActivationIndex && !this.consumeActivation(tokenizer, activation, session)) {
        return undefined;
      }

      const value = parameter.capturer.capture(tokenizer);
      if (value === undefined) {
        return undefined;
      }
      params[name] = value;
    }

    if (tokenizer.hasNext()) {
      return undefined;
    }

    return { type: 'rawPattern', path: [...path], rawPattern, params, activation };
  }

  private *branchesFrom(
    session: Session,
    path: string[],
    options: { includeHidden: boolean },
  ): IterableIterator<RouteBranch> {
    for (const entry of this.entries) {
      switch (entry.type) {
        case 'command':
          if (options.includeHidden || !entry.command.hidden) {
            yield { type: 'command', path: [...path], command: entry.command, meta: entry.command.meta };
          }
          break;
        case 'group':
          yield* entry.router.branchesFrom(session, [...path, entry.name], options);
          break;
        case 'filter':
          if (entry.predicate(session) === true) {
            yield* entry.router.branchesFrom(session, path, options);
          }
          break;
        case 'rawPattern':
          yield {
            type: 'rawPattern',
            path: [...path],
            rawPattern: entry.rawPattern,
            meta: entry.rawPattern.meta,
          };
          break;
      }
    }
  }

  private applyScopeMeta<T extends { meta?: RouteMeta }>(route: T): T {
    if (this.scopeMeta === undefined) {
      return route;
    }

    const meta = mergeRouteMeta(route.meta, this.scopeMeta);
    if (meta === undefined) {
      return route;
    }
    return { ...route, meta };
  }

  private resolveAliasConflicts<P extends Pattern>(command: Command<P>): void {
    for (const entry of this.entries) {
      if (entry.type !== 'command') continue;
      const existing = entry.command;

      if (existing.aliases?.includes(command.name)) {
        existing.aliases = existing.aliases.filter((a) => a !== command.name);
        console.warn(
          `Command "${command.name}" conflicts with alias of existing command "${existing.name}". The alias "${command.name}" has been removed from "${existing.name}".`,
        );
      }

      if (command.aliases) {
        const dropped: string[] = [];
        for (const alias of command.aliases) {
          if (existing.name === alias) {
            dropped.push(alias);
            console.warn(
              `Alias "${alias}" of command "${command.name}" conflicts with existing command name "${existing.name}". The alias has been dropped.`,
            );
          } else if (existing.aliases?.includes(alias)) {
            existing.aliases = existing.aliases.filter((a) => a !== alias);
            console.warn(
              `Alias "${alias}" of command "${command.name}" conflicts with alias of existing command "${existing.name}". The alias has been removed from "${existing.name}".`,
            );
          }
        }
        if (dropped.length > 0) {
          command.aliases = command.aliases.filter((a) => !dropped.includes(a));
        }
      }
    }
  }

  private validatePattern(pattern: Pattern, options?: { rawPattern?: boolean }): void {
    const entries = Object.entries(pattern);

    if (options?.rawPattern && entries.length === 0) {
      throw new Error('Raw pattern must have at least one parameter.');
    }

    const catchAllEntryIndex = entries.findIndex(([, parameter]) => {
      return parameter.capturer.typeInstruction.type === 'catchAll';
    });
    if (catchAllEntryIndex !== -1 && catchAllEntryIndex !== entries.length - 1) {
      throw new Error('Catch-all parameters must be the last parameter in a pattern.');
    }
  }

  private capturePattern<P extends Pattern>(pattern: P, tokenizer: Tokenizer): ParamsOf<P> | undefined {
    const initialState = tokenizer.getState();
    const params = {} as ParamsOf<P>;

    for (const [name, parameter] of Object.entries(pattern)) {
      const value = parameter.capturer.capture(tokenizer);
      if (value === undefined) {
        tokenizer.setState(initialState);
        return undefined;
      }
      params[name as keyof P] = value;
    }

    return params;
  }
}
