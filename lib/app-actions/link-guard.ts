import type { LinkAnswer } from '@/lib/app-adapter/types';
import { linkJson } from '@/lib/app-adapter/link-json';
import { BATCH_TOOL } from '@/lib/workbench/values';
import type { ActionJudge, ActionVerdict } from '@/lib/app-actions/grant';

/**
 * The second guard on a ready-made App's link (the bot server's gate is the first): an action that is Off for this Brick never runs, and
 * the App's own lookups (its search and its schemas) never show one to the Brick. Uses a day, lends, a team's pause and the month's
 * spending stop are checked as before, on every use; this adds to them and replaces none.
 */

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** How deep a batch inside a batch is looked into (the same bound as the sandbox check). */
const BATCH_DEPTH = 8;

/** The provider's own meta tools and Universe's code job tools are not App actions: they are never judged as one. */
const isMetaTool = (name: string): boolean => /^(COMPOSIO|UNIVERSE)_/i.test(name.trim());

/**
 * The App actions a call runs: the call's own name when it is an action, or every action inside a batch, at any depth. A batch nested
 * past the bound counts as the batch itself (never trusted as empty). Meta tools (search, schemas, connections) run no action.
 */
export function actionsOfCall(name: string, args: unknown, depth = 0): string[] {
  const tool = name.trim();
  if (tool.toUpperCase() !== BATCH_TOOL) return isMetaTool(tool) ? [] : [tool];
  if (depth >= BATCH_DEPTH) return [tool];
  const list = isObject(args) ? args.tools : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => (isObject(entry) && typeof entry.tool_slug === 'string' ? actionsOfCall(entry.tool_slug, entry.arguments ?? entry.parameters, depth + 1) : []));
}

/** The actions of a call that are Off for this Brick, each once, in the order they were asked. */
export function offActions(judge: ActionJudge, slugs: readonly string[]): ActionVerdict[] {
  const seen = new Set<string>();
  const off: ActionVerdict[] = [];
  for (const slug of slugs) {
    const key = slug.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const verdict = judge.judge(slug);
    if (verdict.setting === 'off') off.push(verdict);
  }
  return off;
}

/** The words a Brick reads when a call holds an action that is Off: what is off, that nothing ran, and that it may offer the rest. */
export function offWords(off: readonly ActionVerdict[], brick: string, app: string): string {
  const names = off.map((verdict) => verdict.title);
  const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${listed} ${names.length === 1 ? 'is' : 'are'} off for ${brick} in ${app}. Nothing in this request was done. Tell the person, and offer what you may still do; do not ask for ${names.length === 1 ? 'it' : 'them'} again.`;
}

/** A tool result the link would send, saying the call did not run (an error the Brick reads). */
export function refusalAnswer(id: unknown, text: string): LinkAnswer {
  const body = { jsonrpc: '2.0', id: typeof id === 'number' || typeof id === 'string' ? id : null, result: { content: [{ type: 'text', text }], isError: true } };
  return { status: 200, contentType: 'application/json', sessionId: null, body: JSON.stringify(body) };
}

/** A value that names one of this App's actions the way its lists do (GMAIL_FETCH_EMAILS for Gmail): only such a value is ever taken out. */
const slugOfApp = (toolkit: string) => {
  const prefix = `${toolkit.toUpperCase().replace(/[^A-Z0-9]/g, '')}_`;
  return (value: string): boolean => {
    const text = value.trim();
    return text.startsWith(prefix) && /^[A-Z0-9]+(_[A-Z0-9]+)+$/.test(text);
  };
};

const NAME_KEYS = ['tool_slug', 'slug', 'name', 'tool', 'toolSlug'];

/** Takes every mention of an Off action out of a value: list entries that are it or name it, and keys that are it. */
function scrub(value: unknown, isOff: (slug: string) => boolean, looksLikeSlug: (value: string) => boolean, depth = 0): { value: unknown; changed: boolean } {
  if (depth > 32) return { value, changed: false };
  if (Array.isArray(value)) {
    let changed = false;
    const kept: unknown[] = [];
    for (const item of value) {
      if (typeof item === 'string' && looksLikeSlug(item) && isOff(item)) {
        changed = true;
        continue;
      }
      if (isObject(item) && NAME_KEYS.some((key) => typeof item[key] === 'string' && looksLikeSlug(item[key] as string) && isOff(item[key] as string))) {
        changed = true;
        continue;
      }
      const inner = scrub(item, isOff, looksLikeSlug, depth + 1);
      changed ||= inner.changed;
      kept.push(inner.value);
    }
    return { value: kept, changed };
  }
  if (isObject(value)) {
    let changed = false;
    const kept: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (looksLikeSlug(key) && isOff(key)) {
        changed = true;
        continue;
      }
      const inner = scrub(item, isOff, looksLikeSlug, depth + 1);
      changed ||= inner.changed;
      kept[key] = inner.value;
    }
    return { value: kept, changed };
  }
  return { value, changed: false };
}

/**
 * An answer of the App's link with every Off action taken out: its list of tools, and what its search and schema lookups say (their
 * text is JSON, read and written back). An answer that is an error, or that names no Off action, is passed on exactly as it came.
 */
export function withoutOffActions(answer: LinkAnswer, id: unknown, judge: ActionJudge): LinkAnswer {
  if (answer.status >= 400) return answer;
  const parsed = linkJson(answer.body, typeof id === 'number' || typeof id === 'string' ? id : undefined);
  if (!parsed || !isObject(parsed.result)) return answer;
  const isOff = (slug: string) => judge.judge(slug).setting === 'off';
  const looksLikeSlug = slugOfApp(judge.toolkit);
  const result = { ...parsed.result };
  let changed = false;
  if (Array.isArray(result.tools)) {
    const tools = scrub(result.tools, isOff, looksLikeSlug);
    result.tools = tools.value;
    changed ||= tools.changed;
  }
  if (Array.isArray(result.content)) {
    result.content = result.content.map((part) => {
      if (!isObject(part) || part.type !== 'text' || typeof part.text !== 'string') return part;
      let inner: unknown;
      try {
        inner = JSON.parse(part.text);
      } catch {
        return part;
      }
      const cleaned = scrub(inner, isOff, looksLikeSlug);
      if (!cleaned.changed) return part;
      changed = true;
      return { ...part, text: JSON.stringify(cleaned.value) };
    });
  }
  if (isObject(result.structuredContent)) {
    const cleaned = scrub(result.structuredContent, isOff, looksLikeSlug);
    result.structuredContent = cleaned.value;
    changed ||= cleaned.changed;
  }
  if (!changed) return answer;
  return { ...answer, contentType: 'application/json', body: JSON.stringify({ ...parsed, result }) };
}
