/**
 * Bot limits (#666): what each limit is called, its recommended value, and which values can be saved. No database here,
 * so the Orbit pages read the same values the server does. Saving and reading them is lib/bot-limits.ts.
 *
 * Three people set them. A super admin sets Universe AI's reply limits, the artifact limits, the "Say when nothing was
 * saved" switch and fair usage. A key's owner sets the reply limits of bots on that key. A bot's editors can lower the
 * longest reply and the steps for that one bot, never raise them above its key's.
 */

/** The reply limits, the same six for Universe AI and for every key. */
export interface ReplyLimits {
  /** Longest reply, in tokens: what the AI is told it may write in one go, an artifact and any thinking included. */
  reply: number;
  /** Tool steps in one reply before it must answer. */
  steps: number;
  /** Times a cut-off chat answer carries on by itself. */
  continue: number;
  /** Earlier messages in the chat it reads before each reply. */
  memory: number;
  /** Characters it takes in from one web page or file. */
  read: number;
  /** Seconds it waits when its AI goes quiet before it gives up. */
  wait: number;
}

/** The artifact limits, for all bots. */
export interface ArtifactLimits {
  /** Size of one version, in MB. */
  size: number;
  /** Versions one artifact keeps; 0 keeps all of them. */
  versions: number;
  /** Seconds saving a version may take before the bot is told it failed. */
  save: number;
  /** Songs, images and videos one version carries beside its file, all together, in MB (#1510); 0 lets none in. */
  media: number;
}

/** Universe AI fair usage (#1159): replies one person (or all guests on one bot) get every few hours. */
export interface FairUsage {
  signedIn: number;
  guest: number;
  guestPool: number;
}

/** What a super admin sets, all in one place. */
export interface ServerLimits {
  universeAi: ReplyLimits;
  artifacts: ArtifactLimits;
  /** "Say when nothing was saved": a bot that claims an artifact it never saved tries once more, then the chat says so. */
  guard: boolean;
  fairUsage: FairUsage;
}

export const REPLY_LIMITS_RECOMMENDED: ReplyLimits = { reply: 32000, steps: 30, continue: 2, memory: 20, read: 50000, wait: 60 };
export const ARTIFACT_LIMITS_RECOMMENDED: ArtifactLimits = { size: 2, versions: 0, save: 30, media: 50 };
export const FAIR_USAGE_RECOMMENDED: FairUsage = { signedIn: 30, guest: 10, guestPool: 200 };
/** The fair usage window. Shown on the rows ("every 5 hours"), not a row of its own. */
export const FAIR_USAGE_WINDOW_HOURS = 5;

export const SERVER_LIMITS_RECOMMENDED: ServerLimits = {
  universeAi: REPLY_LIMITS_RECOMMENDED,
  artifacts: ARTIFACT_LIMITS_RECOMMENDED,
  guard: true,
  fairUsage: FAIR_USAGE_RECOMMENDED,
};

/**
 * The values that can be saved: anything a person might mean, nothing that would break a reply (no 0 tokens, no
 * negative wait). These are not limits on what bots make; the limits are the values people pick inside them.
 */
interface Range {
  min: number;
  max: number;
  /** Whole numbers only (everything but the artifact sizes in MB). */
  whole?: boolean;
}

const REPLY_RANGES: Record<keyof ReplyLimits, Range> = {
  reply: { min: 256, max: 1_000_000, whole: true },
  steps: { min: 1, max: 500, whole: true },
  continue: { min: 0, max: 10, whole: true },
  memory: { min: 1, max: 1_000, whole: true },
  read: { min: 1_000, max: 5_000_000, whole: true },
  wait: { min: 5, max: 3_600, whole: true },
};

const ARTIFACT_RANGES: Record<keyof ArtifactLimits, Range> = {
  size: { min: 0.1, max: 100 },
  versions: { min: 0, max: 1_000_000, whole: true },
  save: { min: 5, max: 600, whole: true },
  media: { min: 0, max: 1_000 },
};

const FAIR_USAGE_RANGES: Record<keyof FairUsage, Range> = {
  signedIn: { min: 1, max: 1_000_000, whole: true },
  guest: { min: 1, max: 1_000_000, whole: true },
  guestPool: { min: 1, max: 1_000_000, whole: true },
};

const fits = (value: unknown, range: Range): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= range.min && value <= range.max && (!range.whole || Number.isInteger(value));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A saved group read back: each value that is there and fits, the recommended one for the rest. */
function readGroup<T extends object>(saved: unknown, ranges: Record<keyof T, Range>, recommended: T): T {
  const out = { ...recommended };
  if (!isRecord(saved)) return out;
  for (const key of Object.keys(ranges) as (keyof T)[]) {
    const value = saved[key as string];
    if (fits(value, ranges[key])) (out as Record<keyof T, number>)[key] = value;
  }
  return out;
}

export const readReplyLimits = (saved: unknown): ReplyLimits => readGroup(saved, REPLY_RANGES, REPLY_LIMITS_RECOMMENDED);

export function readServerLimits(saved: unknown): ServerLimits {
  const all = isRecord(saved) ? saved : {};
  return {
    universeAi: readReplyLimits(all.universeAi),
    artifacts: readGroup(all.artifacts, ARTIFACT_RANGES, ARTIFACT_LIMITS_RECOMMENDED),
    guard: typeof all.guard === 'boolean' ? all.guard : SERVER_LIMITS_RECOMMENDED.guard,
    fairUsage: readGroup(all.fairUsage, FAIR_USAGE_RANGES, FAIR_USAGE_RECOMMENDED),
  };
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** A change to one group: only known names, each inside its range. Says which one is wrong. */
function checkGroup<T extends object>(input: unknown, ranges: Record<keyof T, Range>, group: string): Checked<Partial<T>> {
  if (!isRecord(input)) return { ok: false, error: `${group} must be an object` };
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    // Only the limits' own names: `constructor` and `toString` are on every object and are not limits
    const range = Object.prototype.hasOwnProperty.call(ranges, key) ? (ranges as Record<string, Range | undefined>)[key] : undefined;
    if (!range) return { ok: false, error: `Unknown limit: ${group}.${key}` };
    if (!fits(value, range)) {
      return { ok: false, error: `${group}.${key} must be ${range.whole ? 'a whole number ' : ''}from ${range.min.toLocaleString('en')} to ${range.max.toLocaleString('en')}` };
    }
    (out as Record<string, number>)[key] = value as number;
  }
  return { ok: true, value: out };
}

export const checkReplyLimits = (input: unknown, group = 'limits'): Checked<Partial<ReplyLimits>> => checkGroup(input, REPLY_RANGES, group);

/** A super admin's change: any of the four parts, each checked. */
export function checkServerLimits(input: unknown): Checked<Partial<{ universeAi: Partial<ReplyLimits>; artifacts: Partial<ArtifactLimits>; guard: boolean; fairUsage: Partial<FairUsage> }>> {
  if (!isRecord(input)) return { ok: false, error: 'Expected an object' };
  const out: Partial<{ universeAi: Partial<ReplyLimits>; artifacts: Partial<ArtifactLimits>; guard: boolean; fairUsage: Partial<FairUsage> }> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'guard') {
      if (typeof value !== 'boolean') return { ok: false, error: 'guard must be true or false' };
      out.guard = value;
      continue;
    }
    const ranges = key === 'universeAi' ? REPLY_RANGES : key === 'artifacts' ? ARTIFACT_RANGES : key === 'fairUsage' ? FAIR_USAGE_RANGES : null;
    if (!ranges) return { ok: false, error: `Unknown setting: ${key}` };
    const checked = checkGroup(value, ranges as Record<string, Range>, key);
    if (!checked.ok) return checked;
    (out as Record<string, unknown>)[key] = checked.value;
  }
  return { ok: true, value: out };
}

/** A bot's own longest reply or steps: null follows the key, a number is at least the smallest value that can be saved. */
export function checkBotLimit(value: unknown, which: 'reply' | 'steps'): Checked<number | null> {
  if (value === null) return { ok: true, value: null };
  const range = REPLY_RANGES[which];
  if (!fits(value, range)) return { ok: false, error: `${which === 'reply' ? 'maxReplyTokens' : 'maxSteps'} must be null or a whole number from ${range.min} to ${range.max.toLocaleString('en')}` };
  return { ok: true, value };
}

/** A bot's limits: its key's (or Universe AI's), with its own longest reply and steps when they are lower. */
export function limitsForBot(base: ReplyLimits, bot: { maxReplyTokens?: number | null; maxSteps?: number | null }): ReplyLimits {
  return {
    ...base,
    reply: bot.maxReplyTokens ? Math.min(base.reply, bot.maxReplyTokens) : base.reply,
    steps: bot.maxSteps ? Math.min(base.steps, bot.maxSteps) : base.steps,
  };
}

/** Bytes in one artifact version. */
export const artifactBytes = (limits: ArtifactLimits): number => Math.round(limits.size * 1024 * 1024);

/** Bytes of media one artifact version may carry (#1510). */
export const artifactMediaBytes = (limits: ArtifactLimits): number => Math.round(limits.media * 1024 * 1024);
