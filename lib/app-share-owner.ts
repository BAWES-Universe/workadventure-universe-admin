import { Prisma, type AppConnection } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getBrickLimits } from '@/lib/bot-limits';
import { getOwnedConnection } from '@/lib/app-connections';
import { thingName } from '@/lib/app-things';
import { startOfDay } from '@/lib/app-uses';
import { SHAREABLE_HEADINGS, isAppShareable } from '@/lib/app-share';
import { ownsBrick } from '@/lib/brick';
import { testMcpConnection, type McpToolShape } from '@/lib/mcp/test-connection';

/**
 * The owner's side of "Other people: only you" (game #2006, mock Part 17 pictures 1 to 9): see what can be shared, start sharing
 * with the jobs they pick, change the jobs and the two limits, and stop. Only the owner of the app and of the Brick reaches any of
 * it; anyone else's id answers like one that does not exist. The app's link, key and account are never returned.
 */

export const NOT_FOUND = 'App not found';

export const jobInputSchema = z
  .object({
    /** The tool, by its name in the app. */
    tool: z.string().trim().min(1).max(255),
    /** The names of the inputs people may fill in. Every input the tool needs must be here, or nobody could ask for it. */
    inputs: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
    /** The names of the fields that may come back, or null for the whole answer (only for a tool that does not say what it gives back). */
    returns: z.array(z.string().trim().min(1).max(200)).max(100).nullable().default(null),
  })
  .strict();

const usesSchema = z.number().int().min(1).max(1_000_000);

/** POST: start sharing. No jobs picked means "the one job there is", when there is exactly one. */
export const startShareSchema = z
  .object({ jobs: z.array(jobInputSchema).min(1).max(50).optional(), usesPerDayEveryone: usesSchema.optional(), usesPerDayPerson: usesSchema.optional() })
  .strict();

/** PATCH: change what can be asked for, and the two limits. Stopping altogether is DELETE. */
export const changeShareSchema = z
  .object({ jobs: z.array(jobInputSchema).min(1).max(50).optional(), usesPerDayEveryone: usesSchema.optional(), usesPerDayPerson: usesSchema.optional() })
  .strict();

export interface JobCandidate {
  tool: string;
  /** "Make a song": the tool's name as a person reads it. */
  title: string;
  description: string | null;
  heading: string;
  fingerprint: string;
  inputs: { name: string; required: boolean }[];
  /** Names of the fields of its answer, or null when it does not say. */
  outputs: string[] | null;
}

export interface JobView {
  tool: string;
  title: string;
  description: string | null;
  heading: string;
  picked: boolean;
  /** A job picked earlier whose tool changed, was moved or is not confirmed any more: it is not shared until it is picked again. */
  needsPicking: boolean;
  inputs: { name: string; required: boolean; picked: boolean }[];
  returns: { names: string[] | null; picked: string[] | null };
}

export interface ShareView {
  /** False for an app signed in as the person: its page says "Only for you", with no button. */
  shareable: boolean;
  shared: boolean;
  /** Whether the app answered when its jobs were read; when not, what can be asked for cannot be picked right now. */
  reachable: boolean;
  limits: { usesPerDayEveryone: number; usesPerDayPerson: number };
  /** Uses today, for everyone together; a use given back is not counted. */
  usedToday: number;
  jobs: JobView[];
}

type Grant = Prisma.BotMcpServerGetPayload<{ include: { tools: true; share: { include: { jobs: true } } } }>;

const list = (value: Prisma.JsonValue | null | undefined): string[] | null =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : null;

/** The Brick's use of the person's own app, with the app: null unless both are theirs (a room bot, a Brick waiting deleted and someone else's are all "not found"). */
async function ownGrant(ownerId: string, connectionId: string, botId: string): Promise<{ connection: AppConnection; grant: Grant } | null> {
  const connection = await getOwnedConnection(connectionId, ownerId);
  if (!connection) return null;
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { roomId: true, ownerId: true, deletedAt: true } });
  if (!bot || !ownsBrick(bot, ownerId)) return null;
  const grant = await prisma.botMcpServer.findFirst({ where: { botId, connectionId }, include: { tools: true, share: { include: { jobs: true } } } });
  return grant ? { connection, grant } : null;
}

/** What the app's tools take and give back, read from the app itself, or null when it cannot be reached right now. */
async function liveShapes(connection: AppConnection): Promise<Map<string, McpToolShape> | null> {
  try {
    const read = await testMcpConnection({ serverUrl: connection.serverUrl, authType: connection.authType, authConfig: connection.authConfig, headers: connection.headers as Record<string, string> | null });
    if (!read.success || !read.tools) return null;
    return new Map(read.tools.map((tool) => [tool.name, tool]));
  } catch {
    return null;
  }
}

/** The jobs this Brick's use of the app could offer: its confirmed tools under a heading that can be shared, with what each takes and gives back. */
function candidatesOf(grant: Grant, shapes: Map<string, McpToolShape> | null): JobCandidate[] {
  return grant.tools
    .filter((tool) => tool.confirmedAt && tool.heading && (SHAREABLE_HEADINGS as readonly string[]).includes(tool.heading))
    // A tool the app did not list just now (gone, or past the pages that are read) cannot be held to inputs or to what comes back, so it is not offered
    .filter((tool) => !shapes || shapes.has(tool.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => {
      const shape = shapes?.get(tool.name);
      return {
        tool: tool.name,
        title: tool.title?.trim() || thingName(tool.name, null),
        description: shape?.description ?? tool.description ?? null,
        heading: tool.heading as string,
        fingerprint: tool.fingerprint,
        inputs: shape?.inputs ?? [],
        outputs: shape?.outputs ?? null,
      };
    });
}

export type ShareProblem = 'unknown_job' | 'bad_input' | 'missing_input' | 'bad_return' | 'no_job' | 'unreachable';

export interface ResolvedJob {
  tool: string;
  fingerprint: string;
  inputs: string[];
  returns: string[] | null;
}

/**
 * Holds the jobs people asked for to what the app really offers: a tool that can be shared, only inputs it has, every input it needs, and only
 * fields it says it gives back (a tool that says nothing gives back its whole answer, so nothing narrower can be promised).
 */
export function resolveJobs(requested: z.infer<typeof jobInputSchema>[], candidates: JobCandidate[], reachable: boolean): { ok: true; jobs: ResolvedJob[] } | { ok: false; problem: ShareProblem; tool?: string } {
  if (!reachable) return { ok: false, problem: 'unreachable' };
  const jobs: ResolvedJob[] = [];
  const seen = new Set<string>();
  for (const job of requested) {
    if (seen.has(job.tool)) continue;
    seen.add(job.tool);
    const candidate = candidates.find((entry) => entry.tool === job.tool);
    if (!candidate) return { ok: false, problem: 'unknown_job', tool: job.tool };
    const inputs = [...new Set(job.inputs)];
    const known = new Set(candidate.inputs.map((input) => input.name));
    if (inputs.some((name) => !known.has(name))) return { ok: false, problem: 'bad_input', tool: job.tool };
    if (candidate.inputs.some((input) => input.required && !inputs.includes(input.name))) return { ok: false, problem: 'missing_input', tool: job.tool };
    let returns: string[] | null = null;
    if (candidate.outputs === null) {
      if (job.returns !== null) return { ok: false, problem: 'bad_return', tool: job.tool };
    } else if (job.returns !== null) {
      returns = [...new Set(job.returns)];
      if (returns.some((name) => !(candidate.outputs as string[]).includes(name))) return { ok: false, problem: 'bad_return', tool: job.tool };
    } else {
      // Nothing narrower asked for: all the fields the tool says it gives back, named, never "whatever comes"
      returns = [...candidate.outputs];
    }
    jobs.push({ tool: candidate.tool, fingerprint: candidate.fingerprint, inputs, returns });
  }
  return { ok: true, jobs };
}

const startingLimits = async () => {
  const limits = await getBrickLimits();
  return { usesPerDayEveryone: limits.sharedUsesEveryone, usesPerDayPerson: limits.sharedUsesPerPerson };
};

const usedTodayOf = (shareId: string) => prisma.appShareUse.count({ where: { shareId, createdAt: { gte: startOfDay() }, status: { not: 'refunded' } } });

function toView(grant: Grant, candidates: JobCandidate[], reachable: boolean, shareable: boolean, limits: ShareView['limits'], usedToday: number): ShareView {
  const picked = new Map((grant.share?.jobs ?? []).map((job) => [job.toolName, job]));
  const views: JobView[] = candidates.map((candidate) => {
    const job = picked.get(candidate.tool);
    const current = !!job && job.fingerprint === candidate.fingerprint;
    const inputs = job ? (list(job.inputs) ?? []) : [];
    const returns = job ? list(job.returns) : null;
    return {
      tool: candidate.tool,
      title: candidate.title,
      description: candidate.description,
      heading: candidate.heading,
      picked: current,
      needsPicking: !!job && !current,
      inputs: candidate.inputs.map((input) => ({ ...input, picked: current && inputs.includes(input.name) })),
      returns: { names: candidate.outputs, picked: current ? returns : null },
    };
  });
  // A job picked earlier whose tool is no longer a candidate at all (gone, moved to another heading, not confirmed) is listed so the owner sees it
  for (const job of picked.values()) {
    if (candidates.some((candidate) => candidate.tool === job.toolName)) continue;
    views.push({ tool: job.toolName, title: thingName(job.toolName, null), description: null, heading: '', picked: false, needsPicking: true, inputs: [], returns: { names: null, picked: null } });
  }
  return { shareable, shared: !!grant.share, reachable, limits, usedToday, jobs: views };
}

/** What the app's page shows under "Other people", or null when the app or the Brick is not theirs. */
export async function readShare(ownerId: string, connectionId: string, botId: string): Promise<ShareView | null> {
  const found = await ownGrant(ownerId, connectionId, botId);
  if (!found) return null;
  const { connection, grant } = found;
  const shareable = isAppShareable(connection);
  const limits = grant.share ? { usesPerDayEveryone: grant.share.usesPerDayEveryone, usesPerDayPerson: grant.share.usesPerDayPerson } : await startingLimits();
  if (!shareable) return toView(grant, [], true, false, limits, 0);
  const shapes = await liveShapes(connection);
  return toView(grant, candidatesOf(grant, shapes), shapes !== null, true, limits, grant.share ? await usedTodayOf(grant.share.id) : 0);
}

export type StartResult = { status: 'started' | 'already'; view: ShareView } | { status: 'not_found' } | { status: 'not_shareable' } | { status: 'refused'; problem: ShareProblem; tool?: string };

/**
 * "Let others use it": starts sharing the jobs the owner picked, with the starting limits (a super admin's, in Limits) or the ones
 * they chose. With no job picked, the one job there is. Asked again for a share that exists, the answer is that share, unchanged.
 */
export async function startShare(ownerId: string, connectionId: string, botId: string, input: z.infer<typeof startShareSchema>): Promise<StartResult> {
  const found = await ownGrant(ownerId, connectionId, botId);
  if (!found) return { status: 'not_found' };
  const { connection, grant } = found;
  if (!isAppShareable(connection)) return { status: 'not_shareable' };
  if (grant.share) return { status: 'already', view: (await readShare(ownerId, connectionId, botId)) as ShareView };
  const shapes = await liveShapes(connection);
  const candidates = candidatesOf(grant, shapes);
  const requested = input.jobs ?? (candidates.length === 1 ? [{ tool: candidates[0].tool, inputs: candidates[0].inputs.map((entry) => entry.name), returns: null }] : []);
  if (requested.length === 0) return { status: 'refused', problem: 'no_job' };
  const resolved = resolveJobs(requested, candidates, shapes !== null);
  if (!resolved.ok) return { status: 'refused', problem: resolved.problem, tool: resolved.tool };
  const limits = await startingLimits();
  try {
    await prisma.appShare.create({
      data: {
        serverId: grant.id,
        sharedById: ownerId,
        usesPerDayEveryone: input.usesPerDayEveryone ?? limits.usesPerDayEveryone,
        usesPerDayPerson: input.usesPerDayPerson ?? limits.usesPerDayPerson,
        jobs: { create: resolved.jobs.map((job) => ({ toolName: job.tool, fingerprint: job.fingerprint, inputs: job.inputs, returns: job.returns ?? Prisma.JsonNull })) },
      },
    });
  } catch (error) {
    // A second tap at the same moment: the first one's share stands
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
    return { status: 'already', view: (await readShare(ownerId, connectionId, botId)) as ShareView };
  }
  return { status: 'started', view: (await readShare(ownerId, connectionId, botId)) as ShareView };
}

export type ChangeResult = { status: 'changed'; view: ShareView } | { status: 'not_found' } | { status: 'refused'; problem: ShareProblem; tool?: string };

/** "Change": the jobs that can be asked for (the list sent is the whole list: a job left out stops at once) and the two limits. */
export async function changeShare(ownerId: string, connectionId: string, botId: string, patch: z.infer<typeof changeShareSchema>): Promise<ChangeResult> {
  const found = await ownGrant(ownerId, connectionId, botId);
  if (!found || !found.grant.share) return { status: 'not_found' };
  const { connection, grant } = found;
  let resolved: ResolvedJob[] | null = null;
  if (patch.jobs) {
    const shapes = await liveShapes(connection);
    const result = resolveJobs(patch.jobs, candidatesOf(grant, shapes), shapes !== null);
    if (!result.ok) return { status: 'refused', problem: result.problem, tool: result.tool };
    resolved = result.jobs;
  }
  const shareId = found.grant.share.id;
  const changed = await prisma.$transaction(async (tx) => {
    // Held for update: an ask being checked at this moment holds the share shared, so it finishes first, and one that starts after sees the change
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "app_shares" WHERE "id" = ${shareId} FOR UPDATE`;
    if (locked.length === 0) return false;
    if (resolved) {
      await tx.appShareJob.deleteMany({ where: { shareId, toolName: { notIn: resolved.map((job) => job.tool) } } });
      for (const job of resolved) {
        const data = { fingerprint: job.fingerprint, inputs: job.inputs, returns: job.returns ?? Prisma.JsonNull };
        await tx.appShareJob.upsert({ where: { shareId_toolName: { shareId, toolName: job.tool } }, create: { shareId, toolName: job.tool, ...data }, update: data });
      }
    }
    await tx.appShare.update({ where: { id: shareId }, data: { ...(patch.usesPerDayEveryone !== undefined ? { usesPerDayEveryone: patch.usesPerDayEveryone } : {}), ...(patch.usesPerDayPerson !== undefined ? { usesPerDayPerson: patch.usesPerDayPerson } : {}) } });
    return true;
  });
  if (!changed) return { status: 'not_found' };
  return { status: 'changed', view: (await readShare(ownerId, connectionId, botId)) as ShareView };
}

/**
 * "Stop letting others use it": every later ask is refused at once, in a chat that is already open too. A try that already went through
 * is kept in the books as it happened. True when it was shared.
 */
export async function stopShare(ownerId: string, connectionId: string, botId: string): Promise<boolean> {
  const found = await ownGrant(ownerId, connectionId, botId);
  if (!found?.grant.share) return false;
  const shareId = found.grant.share.id;
  return prisma.$transaction(async (tx) => {
    // An ask being checked holds the share shared, so this waits for it, and the next one finds nothing
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "app_shares" WHERE "id" = ${shareId} FOR UPDATE`;
    if (locked.length === 0) return false;
    await tx.appShare.delete({ where: { id: shareId } });
    return true;
  });
}
