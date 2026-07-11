import type { IncomingMessage } from '../protocol/types';
import type { Session } from '../routing/command';
import {
  defaultRouteActivationResolver,
  type RouteActivationInput,
  type RouteActivationResolver,
  type RouteDescriptor,
} from '../routing/router';

export type ContextRouteActivationByScene = Partial<
  Record<IncomingMessage['message_scene'] | 'default', RouteActivationInput>
>;

export type ContextRouteActivation = RouteActivationInput | ContextRouteActivationByScene;

export interface ContextRouteActivationMatcher {
  type?: RouteDescriptor['type'] | readonly RouteDescriptor['type'][];
  plugin?: string | readonly string[];
  context?: string | readonly string[];
  tag?: string | readonly string[];
  command?: string | readonly string[];
  path?: readonly string[];
  route?: readonly string[];
  predicate?: (route: RouteDescriptor, session: Session) => boolean;
}

export interface ContextRouteActivationRule {
  match?: ContextRouteActivationMatcher;
  activation: ContextRouteActivation;
}

export interface ContextRouteActivationConfig {
  default?: ContextRouteActivation;
  rules?: ContextRouteActivationRule | readonly ContextRouteActivationRule[];
}

export interface ContextRoutingOptions {
  activation?: ContextRouteActivationConfig;
  activationResolver?: RouteActivationResolver;
}

export function createContextRouteActivationResolver(
  routing: ContextRoutingOptions | undefined,
  fallback: RouteActivationResolver = defaultRouteActivationResolver,
): RouteActivationResolver {
  if (!routing) {
    return fallback;
  }
  if (routing.activation && routing.activationResolver) {
    throw new Error('Context routing cannot specify both activation and activationResolver.');
  }
  if (routing.activationResolver) {
    return routing.activationResolver;
  }
  if (routing.activation) {
    return compileContextRouteActivationConfig(routing.activation, fallback);
  }
  return fallback;
}

function compileContextRouteActivationConfig(
  config: ContextRouteActivationConfig,
  fallback: RouteActivationResolver,
): RouteActivationResolver {
  return (route, session) => {
    const rules: readonly ContextRouteActivationRule[] =
      config.rules === undefined
        ? []
        : Array.isArray(config.rules)
          ? config.rules
          : [config.rules as ContextRouteActivationRule];
    for (const rule of rules) {
      if (!matchesContextRouteActivationRule(route, session, rule)) {
        continue;
      }
      const activation = resolveContextRouteActivation(rule.activation, session.raw.message_scene);
      if (activation !== undefined) {
        return activation;
      }
    }

    if (config.default !== undefined) {
      const activation = resolveContextRouteActivation(config.default, session.raw.message_scene);
      if (activation !== undefined) {
        return activation;
      }
    }

    return fallback(route, session);
  };
}

function resolveContextRouteActivation(
  activation: ContextRouteActivation,
  scene: IncomingMessage['message_scene'],
): RouteActivationInput | undefined {
  if (Array.isArray(activation) || 'type' in activation) {
    return activation as RouteActivationInput;
  }
  const activationByScene = activation as ContextRouteActivationByScene;
  return activationByScene[scene] ?? activationByScene.default;
}

function matchesContextRouteActivationRule(
  route: RouteDescriptor,
  session: Session,
  rule: ContextRouteActivationRule,
): boolean {
  const match = rule.match;
  if (!match) {
    return true;
  }

  if (!matchesStringSelector(match.type, route.type)) {
    return false;
  }
  if (!matchesStringSelector(match.plugin, routeMetaString(route, 'plugin'))) {
    return false;
  }
  if (!matchesStringSelector(match.context, routeMetaString(route, 'context'))) {
    return false;
  }
  if (!matchesTagSelector(match.tag, route.meta?.tags)) {
    return false;
  }
  if (match.command !== undefined && (route.type !== 'command' || !matchesStringSelector(match.command, route.name))) {
    return false;
  }
  if (match.path !== undefined && !sameStringArray(match.path, route.path)) {
    return false;
  }
  if (match.route !== undefined && !sameStringArray(match.route, routeSegments(route))) {
    return false;
  }
  if (match.predicate && match.predicate(route, session) !== true) {
    return false;
  }

  return true;
}

function routeMetaString(route: RouteDescriptor, key: string): string | undefined {
  const value = route.meta?.[key];
  return typeof value === 'string' ? value : undefined;
}

function matchesStringSelector(selector: string | readonly string[] | undefined, value: string | undefined): boolean {
  if (selector === undefined) {
    return true;
  }
  if (value === undefined) {
    return false;
  }
  return typeof selector === 'string' ? selector === value : selector.includes(value);
}

function matchesTagSelector(
  selector: string | readonly string[] | undefined,
  tags: readonly string[] | undefined,
): boolean {
  if (selector === undefined) {
    return true;
  }
  if (!tags) {
    return false;
  }
  return typeof selector === 'string' ? tags.includes(selector) : selector.some((tag) => tags.includes(tag));
}

function routeSegments(route: RouteDescriptor): readonly string[] {
  if (route.type === 'command') {
    return [...route.path, route.name];
  }
  return route.path;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
