import * as YAML from 'yaml';

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

type ReferenceType = 'env' | 'text' | 'tree';

interface Reference {
  type: ReferenceType;
  target: string;
  expression: string;
}

interface FileFrame {
  path: string;
  realPath: string;
}

interface ValueLocation {
  filePath: string;
  configPath: string;
  stack: FileFrame[];
}

type StringPart = { type: 'text'; value: string } | { type: 'reference'; reference: Reference };

const expressionStart = '${{';
const escapedExpressionStart = '$${{';
const environmentVariableName = /^[A-Za-z_][A-Za-z0-9_]*$/;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function referenceError(message: string, location: ValueLocation, stack = location.stack): Error {
  const chain = stack.map((frame) => frame.path).join(' -> ');
  return new Error(`${message}\nSource: ${location.filePath} at ${location.configPath}\nReference chain: ${chain}`);
}

function propertyPath(parent: string, property: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)) {
    return `${parent}.${property}`;
  }
  return `${parent}[${JSON.stringify(property)}]`;
}

function parseReference(expression: string, location: ValueLocation): Reference {
  const content = expression.slice(expressionStart.length, -2).trim();
  const separator = content.indexOf(':');
  if (separator === -1) {
    throw referenceError(`Invalid reference ${JSON.stringify(expression)}: expected a type followed by ':'.`, location);
  }

  const type = content.slice(0, separator).trim();
  const target = content.slice(separator + 1).trim();
  if (type !== 'env' && type !== 'text' && type !== 'tree') {
    throw referenceError(`Unknown reference type ${JSON.stringify(type)} in ${JSON.stringify(expression)}.`, location);
  }
  if (target.length === 0) {
    throw referenceError(`Invalid reference ${JSON.stringify(expression)}: the target cannot be empty.`, location);
  }
  if (type === 'env' && !environmentVariableName.test(target)) {
    throw referenceError(`Invalid environment variable name ${JSON.stringify(target)}.`, location);
  }

  return { type, target, expression };
}

function splitString(value: string, location: ValueLocation): StringPart[] {
  const parts: StringPart[] = [];
  let text = '';

  for (let index = 0; index < value.length; ) {
    if (value.startsWith(escapedExpressionStart, index)) {
      text += expressionStart;
      index += escapedExpressionStart.length;
      continue;
    }
    if (!value.startsWith(expressionStart, index)) {
      text += value[index];
      index += 1;
      continue;
    }

    if (text.length > 0) {
      parts.push({ type: 'text', value: text });
      text = '';
    }

    const expressionEnd = value.indexOf('}}', index + expressionStart.length);
    if (expressionEnd === -1) {
      throw referenceError(`Unclosed reference expression in ${JSON.stringify(value)}.`, location);
    }
    const expression = value.slice(index, expressionEnd + 2);
    parts.push({ type: 'reference', reference: parseReference(expression, location) });
    index = expressionEnd + 2;
  }

  if (text.length > 0 || parts.length === 0) {
    parts.push({ type: 'text', value: text });
  }
  return parts;
}

function resolveReferencePath(target: string, sourcePath: string): string {
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(path.dirname(sourcePath), target);
}

function readTextReference(reference: Reference, location: ValueLocation): string {
  const referencedPath = resolveReferencePath(reference.target, location.filePath);
  try {
    return readFileSync(referencedPath, 'utf-8').replace(/\r?\n$/, '');
  } catch (error) {
    throw referenceError(
      `Failed to read text reference ${JSON.stringify(reference.target)}: ${describeError(error)}`,
      location,
      [...location.stack, { path: referencedPath, realPath: referencedPath }],
    );
  }
}

function resolveStringReference(reference: Reference, location: ValueLocation, resolveAllReferences: boolean): string {
  if (reference.type === 'tree') {
    throw referenceError(
      `Tree reference ${JSON.stringify(reference.expression)} must occupy the entire configuration value.`,
      location,
    );
  }
  if (!resolveAllReferences) {
    return reference.expression;
  }
  if (reference.type === 'env') {
    const value = process.env[reference.target];
    if (value === undefined) {
      throw referenceError(`Environment variable ${JSON.stringify(reference.target)} is not defined.`, location);
    }
    return value;
  }
  return readTextReference(reference, location);
}

function resolveString(value: string, location: ValueLocation, resolveAllReferences: boolean): unknown {
  const parts = splitString(value, location);
  if (parts.length === 1 && parts[0]?.type === 'reference' && parts[0].reference.type === 'tree') {
    const referencedPath = resolveReferencePath(parts[0].reference.target, location.filePath);
    return parseStructuredFile(referencedPath, location.stack, resolveAllReferences, location);
  }

  return parts
    .map((part) =>
      part.type === 'text' ? part.value : resolveStringReference(part.reference, location, resolveAllReferences),
    )
    .join('');
}

function resolveValue(
  value: unknown,
  location: ValueLocation,
  resolveAllReferences: boolean,
  ancestors = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') {
    return resolveString(value, location, resolveAllReferences);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw referenceError(`Circular YAML value detected at ${location.configPath}.`, location);
    }
    ancestors.add(value);
    try {
      return value.map((item, index) =>
        resolveValue(
          item,
          { ...location, configPath: `${location.configPath}[${index}]` },
          resolveAllReferences,
          ancestors,
        ),
      );
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === 'object' && value !== null) {
    if (ancestors.has(value)) {
      throw referenceError(`Circular YAML value detected at ${location.configPath}.`, location);
    }
    ancestors.add(value);
    try {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          resolveValue(
            item,
            { ...location, configPath: propertyPath(location.configPath, key) },
            resolveAllReferences,
            ancestors,
          ),
        ]),
      );
    } finally {
      ancestors.delete(value);
    }
  }
  return value;
}

function parseStructuredFile(
  filePath: string,
  parentStack: FileFrame[],
  resolveAllReferences: boolean,
  source?: ValueLocation,
): unknown {
  const resolvedPath = path.resolve(filePath);
  const sourceLocation = source ?? { filePath: resolvedPath, configPath: '$', stack: parentStack };
  const extension = path.extname(resolvedPath).toLowerCase();
  if (extension !== '.json' && extension !== '.yml' && extension !== '.yaml') {
    throw referenceError(
      `Unsupported structured file extension ${JSON.stringify(extension || '(none)')} for ${JSON.stringify(resolvedPath)}.`,
      sourceLocation,
      [...parentStack, { path: resolvedPath, realPath: resolvedPath }],
    );
  }

  let realPath: string;
  try {
    realPath = realpathSync(resolvedPath);
  } catch (error) {
    throw referenceError(
      `Failed to resolve structured file ${JSON.stringify(resolvedPath)}: ${describeError(error)}`,
      sourceLocation,
      [...parentStack, { path: resolvedPath, realPath: resolvedPath }],
    );
  }

  const frame = { path: resolvedPath, realPath };
  if (parentStack.some((entry) => entry.realPath === realPath)) {
    throw referenceError(`Circular tree reference detected for ${JSON.stringify(resolvedPath)}.`, sourceLocation, [
      ...parentStack,
      frame,
    ]);
  }
  const stack = [...parentStack, frame];

  let content: string;
  try {
    content = readFileSync(resolvedPath, 'utf-8');
  } catch (error) {
    throw referenceError(
      `Failed to read structured file ${JSON.stringify(resolvedPath)}: ${describeError(error)}`,
      sourceLocation,
      stack,
    );
  }

  let parsed: unknown;
  try {
    parsed = extension === '.json' ? JSON.parse(content) : YAML.parse(content);
  } catch (error) {
    throw referenceError(
      `Failed to parse structured file ${JSON.stringify(resolvedPath)}: ${describeError(error)}`,
      sourceLocation,
      stack,
    );
  }

  return resolveValue(parsed, { filePath: resolvedPath, configPath: '$', stack }, resolveAllReferences);
}

export function parseConfigReferences(filePath: string, resolveAllReferences = false): unknown {
  return parseStructuredFile(filePath, [], resolveAllReferences);
}
