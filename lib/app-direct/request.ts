import { z } from 'zod';
import type { BodyTemplate, Definition, Operation } from '@/lib/app-direct/definition';

/**
 * From an operation of a definition and the arguments the model picked to the one request that is sent. The model chooses an
 * operation and values for its parameters; the host, the path template, the headers and the key are the definition's and the
 * adapter's. Nothing here reads a url, a header or a host from an argument.
 */

export class RequestError extends Error {
  constructor(
    readonly code: 'unknown_operation' | 'bad_arguments',
    message: string,
  ) {
    super(message);
  }
}

function argumentSchema(operation: Operation): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  for (const param of operation.params) {
    let schema: z.ZodType;
    if (param.type === 'number') schema = z.number().finite();
    else if (param.type === 'boolean') schema = z.boolean();
    else {
      let text = z.string().max(param.maxLength ?? 500);
      if (param.in === 'path') text = text.min(1);
      schema = param.oneOf ? z.enum(param.oneOf as [string, ...string[]]) : text;
    }
    shape[param.name] = param.required ? schema : schema.optional();
  }
  return z.object(shape).strict();
}

function fill(template: BodyTemplate, values: Record<string, unknown>): unknown {
  if (Array.isArray(template)) return template.map((item) => fill(item, values)).filter((item) => item !== undefined);
  if (template && typeof template === 'object') {
    const keys = Object.keys(template);
    if (keys.length === 1 && keys[0] === '$param') return values[(template as { $param: string }).$param];
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(template)) {
      const value = fill(item as BodyTemplate, values);
      // A value the model left out (an optional one) is not sent at all, and an object left empty by that is not sent either
      if (value === undefined) continue;
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0 && item && typeof item === 'object' && !('$param' in item)) continue;
      out[key] = value;
    }
    return out;
  }
  return template;
}

export interface BuiltRequest {
  method: string;
  /** Credential-bearing when the key goes in the query: never logged, never stored, never in an error. */
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export function placeKey(definition: Definition, key: string): { header?: [string, string]; query?: [string, string] } {
  const { placement } = definition;
  if (placement.in === 'query') return { query: [placement.name, key] };
  const value = placement.scheme === 'Bearer' ? `Bearer ${key}` : placement.scheme === 'Basic' ? `Basic ${Buffer.from(key, 'utf8').toString('base64')}` : key;
  return { header: [placement.name, value] };
}

export function buildRequest(definition: Definition, operationId: string, rawArguments: unknown, key: string): BuiltRequest {
  const operation = definition.operations.find((candidate) => candidate.id === operationId);
  if (!operation) throw new RequestError('unknown_operation', 'This app has no such operation');
  const parsed = argumentSchema(operation).safeParse(rawArguments ?? {});
  if (!parsed.success) throw new RequestError('bad_arguments', parsed.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; '));
  const values = parsed.data as Record<string, unknown>;

  // A value of "." or ".." would be read as a step up by the URL parser and by a server, even though encoding leaves dots as they are
  for (const param of operation.params) {
    if (param.in === 'path' && (values[param.name] === '.' || values[param.name] === '..')) throw new RequestError('bad_arguments', 'A path value is not allowed');
  }
  const path = operation.path.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name: string) => encodeURIComponent(String(values[name])));
  const url = new URL(`${definition.origin}${path}`);
  if (url.pathname.split('/').some((segment) => segment === '.' || segment === '..') || url.origin !== definition.origin) throw new RequestError('bad_arguments', 'A path value is not allowed');
  for (const param of operation.params) {
    if (param.in === 'query' && values[param.name] !== undefined) url.searchParams.set(param.name, String(values[param.name]));
  }
  const headers: Record<string, string> = { accept: 'application/json' };
  const placed = placeKey(definition, key);
  if (placed.header) headers[placed.header[0].toLowerCase()] = placed.header[1];
  if (placed.query) url.searchParams.set(placed.query[0], placed.query[1]);
  let body: string | undefined;
  if (operation.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(fill(operation.body, values));
  }
  return { method: operation.method, url: url.toString(), headers, body };
}

/** Keeps only the listed fields of an answer (`data[].id`); everything else is dropped, so nothing unexpected reaches the model. */
export function pickFields(source: unknown, paths: string[]): unknown {
  const out: Record<string, unknown> = {};
  for (const path of paths) copyPath(source, out, path.split('.'));
  return out;
}

function copyPath(from: unknown, into: Record<string, unknown>, tokens: string[]): void {
  const [head, ...rest] = tokens;
  const isList = head.endsWith('[]');
  const name = isList ? head.slice(0, -2) : head;
  if (!from || typeof from !== 'object' || Array.isArray(from)) return;
  const value = (from as Record<string, unknown>)[name];
  if (value === undefined || name === '__proto__' || name === 'constructor' || name === 'prototype') return;
  if (rest.length === 0) {
    if (isList) {
      if (Array.isArray(value)) into[name] = value.filter(isPlain);
    } else if (isPlain(value)) into[name] = value;
    return;
  }
  if (isList) {
    if (!Array.isArray(value)) return;
    const list = Array.isArray(into[name]) ? (into[name] as Record<string, unknown>[]) : [];
    value.forEach((item, index) => {
      const target = list[index] ?? {};
      copyPath(item, target, rest);
      list[index] = target;
    });
    into[name] = list;
  } else {
    const target = (into[name] && typeof into[name] === 'object' ? into[name] : {}) as Record<string, unknown>;
    copyPath(value, target, rest);
    if (Object.keys(target).length > 0) into[name] = target;
  }
}

/** Only plain values come back as a leaf: a number, text, true or false, or null. An object or list where a value was named is dropped. */
const isPlain = (value: unknown): boolean => value === null || ['string', 'number', 'boolean'].includes(typeof value);
