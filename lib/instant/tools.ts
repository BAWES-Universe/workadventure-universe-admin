import { prisma } from '@/lib/db';
import { getAdapter } from '@/lib/app-adapter';
import { appKeyOf, brickOwnResearch, personOwnResearch } from '@/lib/instant/asker';
import { instantFundsAreWired } from '@/lib/instant/funds';
import { getInstantLimits, getInstantPause } from '@/lib/instant/state';
import { instantAllowedArguments, instantAppOf, instantCatalog, missingInstantLimits } from '@/lib/instant/values';

/**
 * What a Brick may be offered: the research Apps of the table, on for every Brick's owner by default (none of them when the owner's own App of
 * the same service is on for the Brick: theirs wins), only tools in the trusted table, only while Instant can really run (limits set, not paused, the
 * credit books wired, the provider adapter on), and only those whose simplest run fits "the most one run may cost". A tool with no
 * enforceable top price is never in the list. Each carries Composio's own input schema (the key never leaves Orbit, so the bot
 * server cannot ask for it), kept for an hour.
 */

const SCHEMA_TTL_MS = 60 * 60 * 1000;
const schemas = new Map<string, { at: number; description: string | null; inputSchema: unknown }>();

export interface OfferedTool {
  name: string;
  toolkit: string;
  description: string | null;
  inputSchema: unknown;
  /** The least one run costs the person (before any markup), in micros. For the Brick's own judgement ("this is a small run"), never a bound. */
  fromMicros: number;
  /** The App's name as people know it ("Exa"), never the provider that runs it for Universe. */
  app: string;
  /** What the App is good at, in one line: what the Brick picks an App by. */
  strength: string;
  /**
   * The Brick's owner has never had a run of this App that worked: the Brick's first use of it says, once, in one line, that their own free
   * account of it has no Universe limit. Only in a Brick's listing (the owner is known from the Brick).
   */
  firstUse: boolean;
}

/** Composio's input schema cut to the arguments a run may carry at its priced unit, so a Brick is never invited to ask for what would be refused. */
export function cutSchema(tool: string, schema: unknown): unknown {
  const allowed = instantAllowedArguments(tool);
  if (!allowed || typeof schema !== 'object' || schema === null || Array.isArray(schema)) return schema;
  const source = schema as Record<string, unknown>;
  const properties = typeof source.properties === 'object' && source.properties !== null ? (source.properties as Record<string, unknown>) : {};
  // What admission accepts is laid over what the provider says for each kept argument, so the two are both held: the provider's own type and
  // its other limits stay, and the admission's own (most results, only the basic search, a list that is not empty) are added
  const kept = Object.fromEntries(
    Object.entries(properties)
      .filter(([name]) => allowed.names.includes(name))
      .map(([name, own]) => [name, allowed.constraints[name] ? tighten(own, allowed.constraints[name]) : own]),
  );
  const cut: Record<string, unknown> = { ...source, properties: kept, required: allowed.required.filter((name) => name in kept) };
  // Exa's contents needs pages from one of its two lists, even where the provider words them as optional
  const lists = (allowed.anyOf ?? []).filter((names) => names.every((name) => name in kept)).map((names) => ({ required: names }));
  // Laid beside whatever the provider already says (allOf), never over it
  const beside: unknown[] = lists.length > 0 ? [{ anyOf: lists }] : [];
  // Two lists that together may hold only so many (Exa's contents: urls and ids add up): either list may be as long as the room the other leaves
  if (allowed.together && allowed.together.names.every((name) => name in kept)) {
    const { names, max } = allowed.together;
    beside.push({ anyOf: Array.from({ length: max + 1 }, (_, used) => ({ properties: { [names[0]]: { maxItems: used }, [names[1]]: { maxItems: max - used } } })) });
  }
  if (beside.length > 0) cut.allOf = [...(Array.isArray(source.allOf) ? source.allOf : []), ...beside];
  return cut;
}

const NUMBER_LIMITS = [['minimum', Math.max], ['minItems', Math.max], ['minLength', Math.max], ['maximum', Math.min], ['maxItems', Math.min], ['maxLength', Math.min]] as const;
const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The provider's schema for one argument with admission's limits laid over it, so a value must satisfy BOTH: the numbers meet in the middle (the larger
 * minimum, the smaller maximum), a list of allowed words is cut to the ones both allow, the schema of a list's items is tightened the same way, and
 * everything else of the provider's (its type, its description) stays. A limit that cannot be merged with what the provider says (another type, a list
 * of words with none in common, another pattern) is not written over it: it is added beside it in `allOf`, so both still hold.
 */
function tighten(own: unknown, limit: Record<string, unknown>): unknown {
  const base = isPlain(own) ? { ...own } : {};
  const merged: Record<string, unknown> = { ...base };
  const beside: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(limit)) {
    if (!(key in base)) merged[key] = value;
    else if (JSON.stringify(base[key]) === JSON.stringify(value)) continue;
    else if (NUMBER_LIMITS.some(([name]) => name === key) && typeof base[key] === 'number' && typeof value === 'number') {
      const pick = NUMBER_LIMITS.find(([name]) => name === key)![1];
      merged[key] = pick(base[key] as number, value);
    } else if (key === 'items' && isPlain(base.items) && isPlain(value)) merged.items = tighten(base.items, value);
    else if (key === 'enum' && Array.isArray(base.enum) && Array.isArray(value)) {
      const both = value.filter((word) => (base.enum as unknown[]).includes(word));
      if (both.length > 0) merged.enum = both;
      else beside.enum = value;
    } else beside[key] = value;
  }
  // The provider's own description of the argument is kept; the limits are only added to it
  if (typeof base.description === 'string') merged.description = base.description;
  if (Object.keys(beside).length > 0) merged.allOf = [...(Array.isArray(base.allOf) ? base.allOf : []), beside];
  return merged;
}

export async function offeredInstantTools(botId: string | null): Promise<{ ready: boolean; reason: string | null; tools: OfferedTool[] }> {
  // A Brick's owner's own App of the same service is on for it: the Universe-paid one is not offered beside it
  const own = botId ? await brickOwnResearch(botId) : new Set<string>();
  const offered = await instantToolsWhere((toolkit) => !own.has(appKeyOf(toolkit)));
  if (offered.tools.length === 0 || !botId) return offered;
  const used = await appsUsedByOwner(botId);
  return { ...offered, tools: offered.tools.map((tool) => ({ ...tool, firstUse: !used.has(tool.toolkit) })) };
}

/** The Apps of the table the Brick's owner has had a run of that worked (on any Brick of theirs). */
async function appsUsedByOwner(botId: string): Promise<Set<string>> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { ownerId: true } });
  if (!bot?.ownerId) return new Set();
  const runs = await prisma.instantRun.findMany({ where: { personId: bot.ownerId, state: 'succeeded' }, distinct: ['toolkit'], select: { toolkit: true } });
  return new Set(runs.map((run) => run.toolkit));
}

/** The tools of the table that can run now, for the Apps that `wanted` keeps, cheapest first (a free App is tried before a paid one). */
async function instantToolsWhere(wanted: (toolkit: string) => boolean): Promise<{ ready: boolean; reason: string | null; tools: OfferedTool[] }> {
  const instant = getAdapter()?.instant;
  if (!instant) return { ready: false, reason: 'off', tools: [] };
  if (!instantFundsAreWired()) return { ready: false, reason: 'no_credit', tools: [] };
  const limits = await getInstantLimits();
  if (missingInstantLimits(limits).length > 0) return { ready: false, reason: 'not_set', tools: [] };
  if ((await getInstantPause()).paused) return { ready: false, reason: 'paused', tools: [] };
  const tools: OfferedTool[] = [];
  for (const row of instantCatalog()) {
    const app = instantAppOf(row.toolkit);
    if (!app || !wanted(row.toolkit)) continue;
    if (row.fromMicros > (limits.maxRunMicros ?? 0)) continue;
    let known = schemas.get(row.tool);
    if (!known || Date.now() - known.at > SCHEMA_TTL_MS) {
      try {
        const live = await instant.tool(row.tool);
        // Composio does not serve it as Instant (any more): not offered
        if (!live || !live.instantSupported) continue;
        known = { at: Date.now(), description: live.description, inputSchema: cutSchema(row.tool, live.inputSchema) };
        schemas.set(row.tool, known);
      } catch (error) {
        console.error('[Instant] Could not read a tool:', error instanceof Error ? error.message : 'unknown');
        continue;
      }
    }
    tools.push({ name: row.tool, toolkit: row.toolkit, description: known.description, inputSchema: known.inputSchema, fromMicros: row.fromMicros, app: app.name, strength: app.strength, firstUse: false });
  }
  // Cheapest first, the table's own order between equals: the order the Brick is told to try them in
  tools.sort((a, b) => a.fromMicros - b.fromMicros);
  return { ready: true, reason: null, tools };
}

/**
 * The research Apps a person's Bricks use with nothing to connect, for the Apps page ("Ready to use"): one row for each App that has a tool that
 * can run now, cheapest first, with its name and one line. None that the person connected themselves (theirs is under Connected), and none at
 * all while Instant cannot run. Never a price, an amount or the provider.
 */
export async function instantAppsForPerson(personId: string): Promise<{ key: string; name: string; blurb: string }[]> {
  const own = await personOwnResearch(personId);
  const offered = await instantToolsWhere((toolkit) => !own.has(appKeyOf(toolkit)));
  const apps: { key: string; name: string; blurb: string }[] = [];
  for (const tool of offered.tools) {
    if (apps.some((app) => app.key === tool.toolkit)) continue;
    apps.push({ key: tool.toolkit, name: tool.app, blurb: tool.strength });
  }
  return apps;
}

/** For tests. */
export function forgetToolSchemas(): void {
  schemas.clear();
}
