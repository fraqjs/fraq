import type { ActivationConfig } from '../config';

const directActivation = [{ type: 'direct' }];
type ActivationOverride = NonNullable<ActivationConfig['overrides']>[number];

function buildStringSelectorExpression(values: readonly string[], valueExpression: string): string {
  return `${JSON.stringify(values)}.includes(${valueExpression})`;
}

function buildMatchExpression(match: ActivationOverride['match']): string {
  const expressions: string[] = [];

  if (match.plugin !== undefined) {
    expressions.push(buildStringSelectorExpression(match.plugin, 'route.meta?.plugin'));
  }
  if (match.context !== undefined) {
    expressions.push(buildStringSelectorExpression(match.context, 'route.meta?.context'));
  }
  if (match.tag !== undefined) {
    expressions.push(`${JSON.stringify(match.tag)}.some((tag) => route.meta?.tags?.includes(tag) === true)`);
  }
  if (match.command !== undefined) {
    expressions.push(`route.type === 'command' && ${buildStringSelectorExpression(match.command, 'route.name')}`);
  }

  return expressions.length === 0 ? 'true' : expressions.join(' && ');
}

export function compileActivationResolver(config: ActivationConfig): string {
  const lines = ['(route) => {'];

  for (const override of config.overrides ?? []) {
    lines.push(`  if (${buildMatchExpression(override.match)}) {`);
    lines.push(`    return ${JSON.stringify(override.rule)};`);
    lines.push('  }');
  }

  lines.push(`  return ${JSON.stringify(config.default ?? directActivation)};`);
  lines.push('}');
  return lines.join('\n');
}
