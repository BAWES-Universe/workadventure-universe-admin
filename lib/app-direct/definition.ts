import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isAllowedServerUrl } from '@/lib/mcp/outbound-guard';

/**
 * A service definition: the data a key app is run from (game #2044, Keys for Apps). It is DATA, never code. One HTTPS origin, a
 * few operations (method, path, what the model may fill in, what comes back), where the key goes, and one non-changing request
 * that proves a key works. The model picks an operation and its arguments and nothing else: never the host, the path outside the
 * template, a header, or the key.
 *
 * Definitions come from a tested list we ship (catalog.ts) or from a draft a Brick made from a service's docs that the owner
 * confirmed in the safe form. Nobody reviews either: the owner decides, and the code bounds what happens after.
 */

export const CATEGORIES = ['lookUp', 'make', 'change', 'deleteSend'] as const;
export type Category = (typeof CATEGORIES)[number];

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const PLAIN = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f<>]*$/, 'Plain text only');

const paramSchema = z
  .object({
    name: z.string().regex(NAME),
    type: z.enum(['string', 'number', 'boolean']),
    /** Where it goes: into the path, the query, or the body. */
    in: z.enum(['path', 'query', 'body']),
    required: z.boolean().default(true),
    description: PLAIN.optional(),
    maxLength: z.number().int().min(1).max(5000).optional(),
    /** For a string: the only values allowed. */
    oneOf: z.array(z.string().max(100)).min(1).max(50).optional(),
  })
  .strict();

/** A body is a template of plain values and `{ "$param": "name" }` leaves; the model fills only the leaves. */
export type BodyTemplate = string | number | boolean | null | { $param: string } | BodyTemplate[] | { [key: string]: BodyTemplate };

const bodyTemplate: z.ZodType<BodyTemplate> = z.lazy(() =>
  z.union([
    z.string().max(500),
    z.number(),
    z.boolean(),
    z.null(),
    z.object({ $param: z.string().regex(NAME) }).strict(),
    z.array(bodyTemplate).max(50),
    z.record(z.string().max(60), bodyTemplate),
  ]),
);

const operationSchema = z
  .object({
    id: z.string().regex(NAME),
    /** In plain words, shown to the owner ("Look up a payment"). */
    label: PLAIN,
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    /** "/v2/charges/{chargeId}": literal segments and `{param}` segments only. No query, no fragment, no "..". */
    path: z.string().min(1).max(300),
    params: z.array(paramSchema).max(30).default([]),
    body: bodyTemplate.optional(),
    /** The only fields of the answer that come back, as dotted paths (`data[].id`). Anything else is dropped. */
    returns: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\[\])?(\.[A-Za-z_][A-Za-z0-9_]*(\[\])?){0,6}$/)).min(1).max(60),
    category: z.enum(CATEGORIES),
    /** True only for an operation we tested and classified ourselves (the shipped list). A custom operation is never verified, whatever its method. */
    verified: z.boolean().default(false),
  })
  .strict();

const placementSchema = z.discriminatedUnion('in', [
  z
    .object({
      in: z.literal('header'),
      name: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,40}$/),
      /** `Bearer` and `Basic` write "Bearer <key>" and "Basic <base64 key>"; `none` writes the key alone. */
      scheme: z.enum(['Bearer', 'Basic', 'none']),
    })
    .strict(),
  z.object({ in: z.literal('query'), name: z.string().regex(NAME) }).strict(),
]);

export const definitionSchema = z
  .object({
    version: z.literal(1),
    /** The shipped list's key ("tap"), or "custom" for a draft. */
    service: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
    name: PLAIN.pipe(z.string().max(60)),
    /** The short name used in "Add your {short} key". */
    short: PLAIN.pipe(z.string().max(30)),
    origin: z.string().max(255),
    placement: placementSchema,
    keyHint: PLAIN.optional(),
    helpUrl: z.string().url().max(300).optional(),
    /** Prefixes that tell test keys from real ones, so a switch between them is asked about. */
    modes: z.object({ test: z.string().min(1).max(30), live: z.string().min(1).max(30) }).strict().optional(),
    operations: z.array(operationSchema).min(1).max(40),
    /**
     * The one request that proves a key works. It must be an operation of this definition that changes nothing, and the form
     * says what it will do. `rejected` are the answers that mean "not this key"; any other answer means it was accepted.
     */
    check: z
      .object({
        operation: z.string().regex(NAME),
        arguments: z.record(z.string().max(60), z.union([z.string().max(200), z.number(), z.boolean()])).default({}),
        rejected: z.array(z.number().int().min(300).max(599)).min(1).max(10).default([401, 403]),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((def, ctx) => {
    const origin = normalizeOrigin(def.origin);
    if (!origin.ok) ctx.addIssue({ code: 'custom', path: ['origin'], message: origin.reason });
    else if (origin.origin !== def.origin) ctx.addIssue({ code: 'custom', path: ['origin'], message: 'The address must be written as https://host' });
    const ids = new Set<string>();
    def.operations.forEach((operation, index) => {
      const path = ['operations', index];
      if (ids.has(operation.id)) ctx.addIssue({ code: 'custom', path: [...path, 'id'], message: 'Two operations share an id' });
      ids.add(operation.id);
      const problem = pathProblem(operation.path, operation.params);
      if (problem) ctx.addIssue({ code: 'custom', path: [...path, 'path'], message: problem });
      const names = new Set<string>();
      for (const param of operation.params) {
        if (names.has(param.name)) ctx.addIssue({ code: 'custom', path: [...path, 'params'], message: 'Two parameters share a name' });
        names.add(param.name);
        if (param.in === 'path' && !param.required) ctx.addIssue({ code: 'custom', path: [...path, 'params'], message: 'A path part is always required' });
      }
      const bodyParams = new Set(operation.params.filter((param) => param.in === 'body').map((param) => param.name));
      const used = operation.body === undefined ? new Set<string>() : templateParams(operation.body);
      for (const name of used) if (!bodyParams.has(name)) ctx.addIssue({ code: 'custom', path: [...path, 'body'], message: `The body uses ${name}, which is not a body parameter` });
      for (const name of bodyParams) if (!used.has(name)) ctx.addIssue({ code: 'custom', path: [...path, 'params'], message: `${name} is a body parameter the body never uses` });
      if (operation.body !== undefined && operation.method === 'GET') ctx.addIssue({ code: 'custom', path: [...path, 'body'], message: 'A GET has no body' });
      if (operation.verified && def.service === 'custom') ctx.addIssue({ code: 'custom', path: [...path, 'verified'], message: 'A custom operation is never verified' });
    });
    if (def.check) {
      const operation = def.operations.find((candidate) => candidate.id === def.check?.operation);
      if (!operation) ctx.addIssue({ code: 'custom', path: ['check', 'operation'], message: 'The check is not one of the operations' });
      // Never a POST, whatever it says it does: only a GET that is declared a look-up can prove a key
      else if (operation.method !== 'GET' || operation.category !== 'lookUp') ctx.addIssue({ code: 'custom', path: ['check', 'operation'], message: 'The check must be a GET that only looks something up' });
    }
  });

export type Definition = z.infer<typeof definitionSchema>;
export type Operation = Definition['operations'][number];

function templateParams(template: BodyTemplate, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(template)) template.forEach((item) => templateParams(item, into));
  else if (template && typeof template === 'object') {
    const keys = Object.keys(template);
    if (keys.length === 1 && keys[0] === '$param' && typeof (template as { $param: unknown }).$param === 'string') into.add((template as { $param: string }).$param);
    else Object.values(template).forEach((item) => templateParams(item as BodyTemplate, into));
  }
  return into;
}

/** An origin the key may be sent to: https, the default port, a public name, nothing after the host. Returned as it must be written. */
export function normalizeOrigin(input: string): { ok: true; origin: string; host: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'Not an address' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'The address must start with https://' };
  if (url.username || url.password) return { ok: false, reason: 'The address must not hold a sign-in' };
  if (url.port && url.port !== '443') return { ok: false, reason: 'Only the usual secure port is allowed' };
  if (url.pathname !== '/' || url.search || url.hash) return { ok: false, reason: 'The address is a host only' };
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.') || /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return { ok: false, reason: 'The address must be a public name, not a number' };
  if (!isAllowedServerUrl(`https://${host}/`)) return { ok: false, reason: 'The address points to a private place' };
  return { ok: true, origin: `https://${host}`, host };
}

/** Why a path template is not allowed, or null. Literal segments and `{param}` segments only. */
export function pathProblem(path: string, params: { name: string; in: string }[]): string | null {
  if (!path.startsWith('/')) return 'A path starts with /';
  if (/[?#\\]/.test(path)) return 'A path has no query or fragment';
  const segments = path.slice(1).split('/');
  for (const [index, segment] of segments.entries()) {
    if (segment === '' ) {
      // One trailing slash is how some services write their paths
      if (index === segments.length - 1 && segments.length > 1) continue;
      return 'A path has no empty part';
    }
    const named = /^\{([A-Za-z][A-Za-z0-9_]{0,39})\}$/.exec(segment);
    if (named) {
      if (!params.some((param) => param.name === named[1] && param.in === 'path')) return `${named[1]} is a path part with no parameter`;
      continue;
    }
    if (segment === '.' || segment === '..' || !SEGMENT.test(segment)) return 'A path part is not allowed';
  }
  for (const param of params) if (param.in === 'path' && !path.includes(`{${param.name}}`)) return `${param.name} is not in the path`;
  return null;
}

/** The same definition always hashes the same, whatever order its keys were written in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const hashDefinition = (definition: Definition): string => createHash('sha256').update(canonicalJson(definition)).digest('hex');

/** The mode a key is in (`test` or `live`), when the definition can tell. */
export function keyMode(definition: Definition, key: string): 'test' | 'live' | null {
  if (!definition.modes) return null;
  if (key.startsWith(definition.modes.test)) return 'test';
  if (key.startsWith(definition.modes.live)) return 'live';
  return null;
}

/** The registrable-looking part of a host (last two labels, three for the common country suffixes), for the "different site" line. */
export function siteOf(host: string): string {
  const labels = host.toLowerCase().split('.');
  if (labels.length <= 2) return host.toLowerCase();
  const tail = labels.slice(-2).join('.');
  return /^(co|com|org|net|gov|edu|ac)\.[a-z]{2}$/.test(tail) ? labels.slice(-3).join('.') : tail;
}
