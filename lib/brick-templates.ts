import { createHash } from 'node:crypto';
import { Prisma, type BrickTemplate, type BrickTemplateVersion } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ownsBrick } from '@/lib/brick';
import { readCadence, type Cadence } from '@/lib/brick-item-time';
import { blocksSharing, findInText, type Finding } from '@/lib/brick-template-secrets';

/**
 * Sharing a Brick as a template (game #2008, Brick 17), Orbit's half.
 *
 * A template is a COPY, taken at the moment its maker read it in the look. It starts a NEW Brick with its own identity and
 * says what that Brick needs; it never copies credentials, balances, private memory, running computers or funded schedules.
 * What goes with it is only: the look, the one line, the instructions (people can read them first), the first thing to try,
 * what people will need (names, never a link or a sign-in) and routines the maker added on purpose. Never memory, chats,
 * history, apps, keys, sign-ins, grants, recipients, running goals or tasks, files or a computer (NEVER_CARRIED).
 *
 * Three rules hold the rest:
 *  - The look comes first, and the server holds the maker to it. Sharing carries the look's `token`, a hash of exactly
 *    what the maker read. If the Brick changed since, the token no longer matches and nothing is shared: a live private
 *    prompt never goes out by itself, and what was shared is always what was read.
 *  - A shared version never changes. Sharing again writes the next version; Bricks made from an older one are offered the
 *    change to review (lib/brick-template-use.ts) and never receive it by themselves.
 *  - Stopping sharing deletes nobody's Brick. It only stops new Bricks from being made from the template.
 */

/** What a template never carries, for the look and the card ("what stays with the original"). */
export const NEVER_CARRIED = ['memory', 'chats', 'history', 'apps', 'keys', 'signIns', 'grants', 'recipients', 'goalsAndTasks', 'files', 'computer'] as const;

/** everyone: on the Brick's card and in the lists, for anyone who may open it. link: only people who were given the link. */
export const TEMPLATE_AUDIENCES = ['everyone', 'link'] as const;
export type TemplateAudience = (typeof TEMPLATE_AUDIENCES)[number];

/** Routines a maker can add on purpose: things that come back by themselves. A goal, a task or a one-off never goes. */
export const ROUTINE_KINDS = ['reminder', 'schedule', 'watch'] as const;
export type RoutineKind = (typeof ROUTINE_KINDS)[number];

/** What a new Brick will need to do its main job. Names only, never the way into anything. */
export interface Need {
  kind: 'app' | 'computer';
  /** An app's key (its list key or ready-made name, or `link:` and its name for one added by hand); `computer`. */
  key: string;
  label: string;
  /** False when the maker says the main job works without it. */
  required: boolean;
}

/** A routine the maker added on purpose. It arrives switched off. */
export interface Routine {
  kind: RoutineKind;
  words: string;
  condition: string | null;
  cadence: Cadence;
}

export interface RoutineChoice extends Routine {
  /** The maker's own item it was read from: how the look names a choice. Never part of what is shared. */
  id: string;
}

/** What the maker chooses in the look. Everything else is read from the Brick itself, never from the request. */
export const shareChoicesSchema = z
  .object({
    /** Leave out its look: the new Brick takes the next colour its owner has not used. */
    leaveOutLook: z.boolean().default(false),
    /** The first thing to try. Not sent: the Brick's own first line. Empty: none. */
    firstThing: z.string().trim().max(300, 'firstThing must be at most 300 characters').nullish(),
    /** Keys of what people will need that the main job works without. */
    optionalNeeds: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
    /** Which of the maker's own routines go along on purpose. They arrive switched off. */
    routines: z.array(z.string().trim().min(1).max(64)).max(200).default([]),
    audience: z.enum(TEMPLATE_AUDIENCES).default('everyone'),
  })
  .strict();
export type ShareChoices = z.infer<typeof shareChoicesSchema>;

/** The share request: the choices and the token of the look the maker read. */
export const shareRequestSchema = shareChoicesSchema.safeExtend({ token: z.string().trim().min(1).max(64) });

/** Exactly what would be shared, with what the secret check found. This is the look. */
export interface TemplateLook {
  name: string;
  description: string | null;
  /** Its look (a Brick colour or a WOKA), or null when left out. */
  look: string | null;
  instructions: string | null;
  firstThing: string | null;
  needs: Need[];
  routines: Routine[];
  audience: TemplateAudience;
  neverCarried: readonly string[];
  findings: Finding[];
  /** A secret was found: sharing is refused until it is taken out. */
  blocked: boolean;
  /** A hash of what is shared (not of how it is shared): equal hashes are the same version. */
  contentHash: string;
  /** A hash of what the maker read, with who it is for. Sent back to share. */
  token: string;
}

type Content = Pick<TemplateLook, 'name' | 'description' | 'look' | 'instructions' | 'firstThing' | 'needs' | 'routines'>;

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A cadence in a fixed shape and key order, so the same routine always hashes the same. */
function steady(cadence: Cadence): Cadence {
  switch (cadence.type) {
    case 'daily':
      return { type: 'daily', time: cadence.time, days: [...cadence.days].sort((a, b) => a - b) };
    case 'every':
      return { type: 'every', minutes: cadence.minutes };
    case 'once':
      return { type: 'once', at: cadence.at };
    default:
      return { type: 'none' };
  }
}

/** A routine the maker can add is one that comes back by itself: a time of day or a repeat. Never a one-off or a wait. */
function comesBack(cadence: Cadence | null): cadence is Extract<Cadence, { type: 'daily' | 'every' }> {
  return cadence?.type === 'daily' || cadence?.type === 'every';
}

export function contentOf(look: Content): Content {
  return {
    name: look.name,
    description: look.description,
    look: look.look,
    instructions: look.instructions,
    firstThing: look.firstThing,
    needs: look.needs.map((need) => ({ kind: need.kind, key: need.key, label: need.label, required: need.required })),
    routines: look.routines.map((routine) => ({ kind: routine.kind, words: routine.words, condition: routine.condition, cadence: steady(routine.cadence) })),
  };
}

export const hashOf = (content: Content): string => sha(contentOf(content));

const slug = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 100);

/**
 * What a Brick uses today, as names: the apps it may use and whether it has a computer. Read from the Brick, never from the
 * request, so a maker cannot hide a need and the look always says what the new Brick will want.
 */
export async function usedNeeds(botId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<Omit<Need, 'required'>[]> {
  const [servers, computer] = await Promise.all([
    db.botMcpServer.findMany({
      where: { botId, enabled: true },
      select: { name: true, connection: { select: { name: true, catalogKey: true, providerToolkit: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    db.brickComputer.findUnique({ where: { botId }, select: { enabled: true } }),
  ]);
  const found = new Map<string, Omit<Need, 'required'>>();
  for (const server of servers) {
    const label = (server.connection?.name ?? server.name).slice(0, 100);
    const key = server.connection?.catalogKey ?? server.connection?.providerToolkit ?? `link:${slug(label)}`;
    if (!found.has(key)) found.set(key, { kind: 'app', key, label });
  }
  if (computer?.enabled) found.set('computer', { kind: 'computer', key: 'computer', label: 'A computer' });
  return [...found.values()];
}

/** The routines of this Brick its maker may add to a template: their own, coming back by themselves, not set by a goal. */
export async function routineChoices(botId: string, ownerId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<RoutineChoice[]> {
  const rows = await db.brickItem.findMany({
    where: { botId, ownerId, parentId: null, setBy: 'you', kind: { in: [...ROUTINE_KINDS] }, state: { in: ['on', 'paused'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const choices: RoutineChoice[] = [];
  for (const row of rows) {
    const cadence = readCadence(row.cadence);
    if (!comesBack(cadence)) continue;
    choices.push({ id: row.id, kind: row.kind as RoutineKind, words: row.words, condition: row.kind === 'watch' ? row.condition : null, cadence: steady(cadence) });
  }
  return choices;
}

export type Refused = { ok: false; status: 400 | 404 | 409 | 422; error: string; code?: 'changed' | 'secret' | 'routine_gone'; look?: TemplateLook };

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * The look: exactly what would be shared for this Brick with these choices, and what the secret check found in it. Only for
 * the Brick's owner. Writes nothing.
 */
export async function lookAtTemplate(botId: string, ownerId: string, choices: ShareChoices, db: Db = prisma): Promise<{ ok: true; look: TemplateLook } | Refused> {
  const bot = await db.bot.findUnique({
    where: { id: botId },
    select: { roomId: true, ownerId: true, deletedAt: true, name: true, description: true, characterTextureId: true, chatInstructions: true, hello: true },
  });
  if (!bot || !ownsBrick(bot, ownerId)) return { ok: false, status: 404, error: 'Brick not found' };

  const optional = new Set(choices.optionalNeeds);
  const needs: Need[] = (await usedNeeds(botId, db)).map((need) => ({ ...need, required: !optional.has(need.key) }));

  const available = new Map((await routineChoices(botId, ownerId, db)).map((choice) => [choice.id, choice]));
  const routines: Routine[] = [];
  for (const id of [...new Set(choices.routines)]) {
    const choice = available.get(id);
    if (!choice) return { ok: false, status: 422, code: 'routine_gone', error: 'One of the routines you chose is not there any more, or is not one that comes back by itself' };
    routines.push({ kind: choice.kind, words: choice.words, condition: choice.condition, cadence: choice.cadence });
  }

  const firstThing = choices.firstThing === undefined ? bot.hello : choices.firstThing || null;
  const content: Content = {
    name: bot.name,
    description: bot.description?.trim() || null,
    look: choices.leaveOutLook ? null : bot.characterTextureId,
    instructions: bot.chatInstructions?.trim() || null,
    firstThing,
    needs,
    routines,
  };
  const findings = [
    ...findInText(content.name, 'name'),
    ...findInText(content.description, 'description'),
    ...findInText(content.instructions, 'instructions'),
    ...findInText(content.firstThing, 'firstThing'),
    // An app's name is a label its owner can rename, so it is read like any other words that leave with the template
    ...needs.flatMap((need) => findInText(need.label, `need ${need.key}`)),
    ...routines.flatMap((routine, index) => [...findInText(routine.words, `routine ${index + 1}`), ...findInText(routine.condition, `routine ${index + 1}`)]),
  ];
  const contentHash = hashOf(content);
  const look: TemplateLook = {
    ...contentOf(content),
    audience: choices.audience,
    neverCarried: NEVER_CARRIED,
    findings,
    blocked: blocksSharing(findings),
    contentHash,
    token: sha({ contentHash, audience: choices.audience }),
  };
  return { ok: true, look };
}

/** What the maker's page needs to know about a Brick's template. */
export interface MakerTemplate {
  shared: boolean;
  /** Not shared now, but was: sharing again brings it back. */
  stopped: boolean;
  audience: TemplateAudience | null;
  /** The version new Bricks start from; null when never shared. */
  version: number | null;
  sharedAt: string | null;
  /** How many Bricks were made from it and still exist. Only the number: never who, never where. */
  madeFrom: number;
  /** Whether the Brick differs from what was last shared, so "Share your latest changes" has something to say. */
  hasChanges: boolean;
  /** The choices it was shared with, to read the look again from the same place. */
  choices: { leaveOutLook: boolean; routines: string[]; optionalNeeds: string[]; firstThing?: string | null };
  /** The routines of this Brick that can go along on purpose, as the maker last saw them. */
  routineChoices: RoutineChoice[];
  /** What would be shared now, with the same choices: null when it was never shared or cannot be read. */
  latest: TemplateLook | null;
}

function savedChoices(template: BrickTemplate | null, version: BrickTemplateVersion | null) {
  const stored = (template?.choices ?? {}) as { leaveOutLook?: unknown; routines?: unknown; firstThing?: unknown };
  const needs = Array.isArray(version?.needs) ? (version!.needs as unknown as Need[]) : [];
  return {
    leaveOutLook: stored.leaveOutLook === true,
    routines: Array.isArray(stored.routines) ? stored.routines.filter((id): id is string => typeof id === 'string') : [],
    optionalNeeds: needs.filter((need) => need.required === false).map((need) => need.key),
    // Only said when the maker wrote one: otherwise the Brick's own first line is read again each time
    ...('firstThing' in stored ? { firstThing: typeof stored.firstThing === 'string' ? stored.firstThing : null } : {}),
  };
}

/** The maker's page: whether this Brick is shared, how many Bricks were made from it, and what "latest changes" would share. */
export async function readMakerTemplate(botId: string, ownerId: string): Promise<MakerTemplate | null> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { roomId: true, ownerId: true, deletedAt: true } });
  if (!bot || !ownsBrick(bot, ownerId)) return null;
  const template = await prisma.brickTemplate.findUnique({ where: { botId } });
  const version = template ? await prisma.brickTemplateVersion.findUnique({ where: { templateId_number: { templateId: template.id, number: template.currentVersion } } }) : null;
  const choices = savedChoices(template, version);
  const looked = template && version
    ? await lookAtTemplate(botId, ownerId, { leaveOutLook: choices.leaveOutLook, firstThing: choices.firstThing, optionalNeeds: choices.optionalNeeds, routines: choices.routines.filter(Boolean), audience: template.audience as TemplateAudience })
    : null;
  // A routine the maker removed since is not part of "latest": the look is read again without it
  let latest: TemplateLook | null = null;
  let shownChoices = choices;
  if (looked && looked.ok) latest = looked.look;
  else if (looked && looked.code === 'routine_gone') {
    // The choices shown are the surviving ones too, so `choices` and `latest` describe one request that can be sent back
    const without = await withoutGoneRoutines(botId, ownerId, template!, choices);
    latest = without.look;
    shownChoices = { ...choices, routines: without.routines };
  }
  return {
    shared: !!template && !template.stoppedAt,
    stopped: !!template?.stoppedAt,
    audience: template ? (template.audience as TemplateAudience) : null,
    version: template?.currentVersion ?? null,
    sharedAt: version ? version.createdAt.toISOString() : null,
    madeFrom: template ? await countMadeFrom(template.id) : 0,
    hasChanges: !!latest && !!version && latest.contentHash !== version.contentHash,
    choices: shownChoices,
    routineChoices: await routineChoices(botId, ownerId),
    latest,
  };
}

async function withoutGoneRoutines(botId: string, ownerId: string, template: BrickTemplate, choices: ReturnType<typeof savedChoices>): Promise<{ look: TemplateLook | null; routines: string[] }> {
  const still = new Set((await routineChoices(botId, ownerId)).map((choice) => choice.id));
  const routines = choices.routines.filter((id) => still.has(id));
  const answer = await lookAtTemplate(botId, ownerId, { leaveOutLook: choices.leaveOutLook, firstThing: choices.firstThing, optionalNeeds: choices.optionalNeeds, routines, audience: template.audience as TemplateAudience });
  return { look: answer.ok ? answer.look : null, routines };
}

/** Bricks made from a template that still exist (one waiting deleted is not counted). */
export async function countMadeFrom(templateId: string): Promise<number> {
  return prisma.brickTemplateUse.count({ where: { templateId, bot: { deletedAt: null } } });
}

/**
 * "Share as a template" and "Share your latest changes": shares what the maker read. The look is read again here, in the
 * same transaction, and must be the look the token names; if the Brick changed since, nothing is shared and the new look
 * comes back. A secret in it refuses sharing. Sharing what was already shared makes no new version (a double tap, or
 * sharing again after Stop sharing without changing anything brings the same version back); a change makes the next one,
 * and a new version waits to be picked by Universe again.
 */
export async function shareTemplate(botId: string, ownerId: string, request: z.infer<typeof shareRequestSchema>): Promise<{ ok: true; template: MakerTemplate } | Refused> {
  const { token, ...choices } = request;
  const done = await prisma.$transaction(async (tx) => {
    // One at a time per Brick: two taps, or two devices, cannot both write the next version number
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`brick-template:${botId}`}))`;
    const looked = await lookAtTemplate(botId, ownerId, choices, tx);
    if (!looked.ok) return looked;
    const { look } = looked;
    if (look.token !== token) return { ok: false as const, status: 409 as const, code: 'changed' as const, error: 'This Brick changed since you looked. Read it again before you share it.', look };
    if (look.blocked) return { ok: false as const, status: 422 as const, code: 'secret' as const, error: 'Something that looks like a secret is in it. Take it out first.', look };

    const saved = { leaveOutLook: choices.leaveOutLook, routines: choices.routines, ...(choices.firstThing !== undefined ? { firstThing: choices.firstThing ?? null } : {}) } as Prisma.InputJsonValue;
    const content = contentOf(look);
    const existing = await tx.brickTemplate.findUnique({ where: { botId } });
    if (!existing) {
      const made = await tx.brickTemplate.create({ data: { botId, makerId: ownerId, audience: choices.audience, choices: saved } });
      await tx.brickTemplateVersion.create({ data: versionData(made.id, 1, content, look.contentHash) });
      return { ok: true as const };
    }
    const current = await tx.brickTemplateVersion.findUnique({ where: { templateId_number: { templateId: existing.id, number: existing.currentVersion } }, select: { contentHash: true } });
    const same = current?.contentHash === look.contentHash;
    const next = same ? existing.currentVersion : existing.currentVersion + 1;
    if (!same) await tx.brickTemplateVersion.create({ data: versionData(existing.id, next, content, look.contentHash) });
    await tx.brickTemplate.update({
      where: { id: existing.id },
      data: {
        audience: choices.audience,
        choices: saved,
        currentVersion: next,
        stoppedAt: null,
        // A new version, or a template that is no longer for everyone, waits to be picked again
        ...(!same || choices.audience !== 'everyone' || existing.stoppedAt ? { pickedAt: null, pickedById: null } : {}),
      },
    });
    return { ok: true as const };
  });
  if (!done.ok) return done;
  return { ok: true, template: (await readMakerTemplate(botId, ownerId))! };
}

function versionData(templateId: string, number: number, content: Content, contentHash: string): Prisma.BrickTemplateVersionUncheckedCreateInput {
  return {
    templateId,
    number,
    name: content.name,
    description: content.description,
    characterTextureId: content.look,
    chatInstructions: content.instructions,
    firstThing: content.firstThing,
    needs: content.needs as unknown as Prisma.InputJsonValue,
    routines: content.routines as unknown as Prisma.InputJsonValue,
    contentHash,
  };
}

/**
 * "Stop sharing": nobody new can use it, it leaves every list and the Brick's card, and it is no longer picked. Bricks already
 * made from it are not touched, and neither is this Brick. Asked twice, the second answer is the same. Null when the Brick is
 * not its owner's, or was never shared.
 */
export async function stopSharing(botId: string, ownerId: string): Promise<MakerTemplate | null> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { roomId: true, ownerId: true, deletedAt: true } });
  if (!bot || !ownsBrick(bot, ownerId)) return null;
  const template = await prisma.brickTemplate.findUnique({ where: { botId }, select: { id: true, stoppedAt: true } });
  if (!template) return null;
  if (!template.stoppedAt) await prisma.brickTemplate.update({ where: { id: template.id }, data: { stoppedAt: new Date(), pickedAt: null, pickedById: null } });
  return readMakerTemplate(botId, ownerId);
}
