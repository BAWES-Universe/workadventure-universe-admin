import { prisma } from '@/lib/db';
import { RATE_MICROS, tierOf } from '@/lib/composio-rates';
import { connectedState } from '@/lib/app-connections';
import { appUseHasRoom } from '@/lib/app-use-cap';
import { readReadyMadeApps } from '@/lib/app-adapter/settings';
import { isOwnApp, isReadyMade, ownCopyWorks, sameApp } from '@/lib/app-same';
import { BRICK_SHAPE, awakeMicrosPerMinute as publishedAwakeMicrosPerMinute, keptDiskMonthMicros } from '@/lib/agent37/rates';

/**
 * Choosing the route by what the whole task is expected to cost (build handoff v2, section 6, replacing "20 app steps"):
 *
 *   among the authorized routes that can deliver the result well enough, the one with the lowest expected total cost.
 *
 * The model proposes (which connected app could do it, in about how many steps, and whether it truly cannot); the SERVER computes and
 * enforces: the app must be one this Brick has connected, its rate is the provider's published one, and the answer is the cheaper way.
 * "20 steps" is no switch: an app route is chosen for as many steps as it stays cheaper. Rates are values here with the day they were read,
 * never a price said in chat. A rate that is not known is never taken as zero.
 *
 * Eligibility (is the app connected, may this person use the computer) is decided by the caller from its own records; this file is only
 * arithmetic, so the same numbers decide in the test and on the server.
 */

/** A chat turn of the model, about one thousandth of a dollar: Orbit's 28 Oct measurement (about 9.4K tokens in, 47% cached, 430 out). */
export const CHAT_TURN_MICROS = 1_000;
/** One model call of the agent on the computer, about $0.0003: measured live on 13 Nov. */
export const HERMES_CALL_MICROS = 300;
/** What a computer job usually takes: ten awake minutes and the middle of 20 to 60 calls (plan, 13 Nov). Never shown to anyone. */
export const COMPUTER_JOB_MINUTES = 10;
export const COMPUTER_JOB_CALLS = 40;
/** The price of an app step when the app is not one we know the rate of: the dearest tier, never nothing. */
export const UNKNOWN_APP_STEP_MICROS = RATE_MICROS.managed_premium;
/** A plan's step count is read as at least 1 and no more than this: a number out of range is a plan that cannot be trusted either way. */
export const MAX_PLANNED_STEPS = 500;

export type RouteName = 'app' | 'computer';

export interface RouteQuote {
  route: RouteName;
  /** What the whole task is expected to cost, in micros. */
  expectedMicros: number;
  /** For the app way: the app. */
  app?: string;
}

/** The steps the model says an app would take: a whole number from 1 to the most, and anything else is 1. */
export function cleanSteps(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(MAX_PLANNED_STEPS, Math.max(1, Math.ceil(value)));
}

/** The app way: each step is a call at the app's rate and the model turn that makes it. */
export function appQuote(input: { app: string; steps: number; stepMicros: number | null }): RouteQuote {
  const step = input.stepMicros ?? UNKNOWN_APP_STEP_MICROS;
  return { route: 'app', app: input.app, expectedMicros: cleanSteps(input.steps) * (step + CHAT_TURN_MICROS) };
}

/** The computer way: its usual awake minutes, the agent's own calls, and (when the Brick has no machine yet) the month of disk the job would make. */
export function computerQuote(input: { awakeMicrosPerMinute: number | null; hasMachine: boolean }): RouteQuote {
  const perMinute = input.awakeMicrosPerMinute ?? publishedAwakeMicrosPerMinute(BRICK_SHAPE);
  const machine = input.hasMachine ? 0 : keptDiskMonthMicros(BRICK_SHAPE);
  return { route: 'computer', expectedMicros: Math.round(COMPUTER_JOB_MINUTES * perMinute + COMPUTER_JOB_CALLS * HERMES_CALL_MICROS + machine) };
}

/** The lowest expected cost; the app way when two cost the same, because it wakes nothing. At least one quote must be given. */
export function chooseRoute(quotes: RouteQuote[]): RouteQuote {
  return quotes.reduce((best, next) => (next.expectedMicros < best.expectedMicros || (next.expectedMicros === best.expectedMicros && next.route === 'app') ? next : best));
}

// ---------- On the server: which app is really there, and the way the job takes ----------

/** What the model proposes for a job it wants on the computer. Never trusted: the server checks the app and works out the cost itself. */
export interface RoutePlan {
  /** A connected app that could seem to do the job. */
  app?: string | null;
  /** About how many steps (model turns) that app would take. */
  steps?: number | null;
  /** Why that app cannot do it, in the model's own words. Said, the app is not an adequate way and is not weighed. */
  appCannot?: string | null;
}

/** The model says in a few words why the app cannot do it (the same bar the bot server has always used). */
const saidWhy = (text: string | null | undefined) => (text ?? '').trim().length >= 8;

/** A step count the model really gave: a whole number of at least one. Not given, or not a count, there is nothing to weigh the app by. */
const gaveSteps = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 1;

const plain = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The app this Brick really has connected and switched on that this name means: its name as connected, and what one step of it costs us (null: not known). */
export async function connectedApp(botId: string, name: string): Promise<{ name: string; stepMicros: number | null } | null> {
  const wanted = plain(name);
  if (!wanted) return null;
  const found = await prisma.botMcpServer.findMany({ where: { botId, enabled: true, NOT: { connectionId: null } }, include: { connection: true }, orderBy: { createdAt: 'asc' } });
  // Two Apps of the same name (the person's own Exa and the ready-made one): the person's own is weighed first (lib/app-same.ts), at what it costs
  // Universe (nothing), never the ready-made one's price
  // An App that is not ready-made and that the bot server saw fail (ownCopyWorks: a refused sign-in or key, or no answer) is no way at all, whatever
  // its name: it is never weighed, so a broken copy never takes the place of a working way, and with no working way the job takes the computer
  const works = (grant: (typeof found)[number]) => !!grant.connection && ownCopyWorks(connectedState(grant.connection).connected, grant.connection, grant);
  const grants = [...found.filter((grant) => !isReadyMade(grant.connection) && works(grant)), ...found.filter((grant) => isReadyMade(grant.connection))];
  for (const grant of grants) {
    const connection = grant.connection;
    if (!connection) continue;
    const names = [grant.name, connection.name, connection.providerToolkit ?? ''].map(plain);
    if (!names.includes(wanted)) continue;
    // The ready-made one was named but the person has their own copy of it here under another name ("Exa Search" by its link): theirs is the
    // way, also when the ready-made one is signed out (only the own copy has to work)
    if (isReadyMade(connection)) {
      const ownCopy = grants.find((other) => !isReadyMade(other.connection) && isOwnApp(other.connection) && other.connection && sameApp({ name: other.connection.name || other.name, serverUrl: other.connection.serverUrl }, { key: connection.providerToolkit, name: connection.name }));
      if (ownCopy) return { name: ownCopy.name, stepMicros: 0 };
    }
    if (!connectedState(connection).connected) continue;
    // Only a ready-made app is paid for by us at the provider's rate; any other connected app costs us no call (its step is still a model turn)
    if (connection.source !== 'ready_made' || !connection.providerToolkit) return { name: grant.name, stepMicros: connection.source === 'ready_made' ? null : 0 };
    const listed = (await readReadyMadeApps()).find((app) => app.key === connection.providerToolkit);
    return { name: grant.name, stepMicros: RATE_MICROS[tierOf(connection.providerToolkit, !!listed?.authConfigId).tier] };
  }
  return null;
}

/**
 * The review at the checkpoint (the bot server counts a Brick's app steps in one answer and asks at 20): true when the steps taken so far have
 * cost as much as the whole job is expected to cost on the computer, so the Brick should look at whether the computer would finish it for less.
 * It is advice only, never a switch: nothing is stopped, started or woken by it.
 */
export function stepsReview(input: { steps: number; stepMicros: number | null; computer: RouteQuote }): boolean {
  return appQuote({ app: '', steps: input.steps, stepMicros: input.stepMicros }).expectedMicros >= input.computer.expectedMicros;
}

export type Routed = { ok: true; route: 'computer'; expectedMicros: number } | { ok: false; app: string };

/**
 * The way for a job that asked for the computer. The app the model named is weighed only when this Brick really has it connected and the model
 * did not say it cannot do the job and gave about how many steps it would take; if it is the cheaper way the job is not started here (`ok: false`, with the app) and the Brick is told to
 * use it. Otherwise the job takes the computer and carries what it was expected to cost.
 */
export async function routeJob(input: { botId: string; personId?: string | null; plan?: RoutePlan | null; awakeMicrosPerMinute: number | null; hasMachine: boolean }, now: Date = new Date()): Promise<Routed> {
  const computer = computerQuote({ awakeMicrosPerMinute: input.awakeMicrosPerMinute, hasMachine: input.hasMachine });
  const plan = input.plan;
  // Without a count of steps the app is not weighed (a guess of one step would make it win against any computer): the job takes the computer
  if (plan?.app && gaveSteps(plan.steps) && !saidWhy(plan.appCannot)) {
    const app = await connectedApp(input.botId, plan.app);
    if (app) {
      const best = chooseRoute([appQuote({ app: app.name, steps: plan.steps, stepMicros: app.stepMicros }), computer]);
      // An App whose paid steps the spending stop would refuse (the month's or this person's Limit is used up) is no way at all: the computer does it
      const stopped = best.route === 'app' && app.stepMicros !== null && app.stepMicros > 0 && !(await appUseHasRoom(input.personId ?? null, app.stepMicros * cleanSteps(plan.steps), now));
      if (best.route === 'app' && !stopped) return { ok: false, app: app.name };
    }
  }
  return { ok: true, route: 'computer', expectedMicros: computer.expectedMicros };
}
