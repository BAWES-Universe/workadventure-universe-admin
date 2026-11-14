import { Prisma, type AppConnection, type BrickTemplate, type BrickTemplateVersion } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ownsBrick } from '@/lib/brick';
import { connectedState } from '@/lib/app-connections';
import { getBrickLimits } from '@/lib/bot-limits';
import { TIME_ZONE_KEY, isTimeZone, type Cadence } from '@/lib/brick-item-time';
import { makeBrick } from '@/lib/brick-make';
import type { BrickCard } from '@/lib/brick-default';
import { NEVER_CARRIED, type Need, type Routine, type RoutineKind } from '@/lib/brick-templates';

/**
 * Starting a Brick from a template, finding templates, and taking a template's update (game #2008, Brick 17), Orbit's half.
 *
 * "Use template" makes a NEW individual: its own name, its own memory (none), its own grants (none) and its own
 * identity. It starts from what the maker shared and nothing else, and says what it still needs. "Setup required" is said
 * before creating when the main job lacks something, and again on the new Brick's page, until it is set up: it never
 * pretends to be ready. The maker's name stays on it, even after the template stops being shared or goes.
 *
 * Routines the maker added arrive SWITCHED OFF and run only after the new owner sets them up (their time zone, and what the
 * template said the Brick needs) and turns them on. Nothing about a template ever reaches a Brick by itself: a new version
 * is offered as a change to review, and only the parts the owner takes are applied.
 */

type Db = Prisma.TransactionClient | typeof prisma;

/** A template a person may open: shared now, and its Brick is not waiting deleted. */
const OPEN = { stoppedAt: null, bot: { deletedAt: null } } as const;

const asNeeds = (value: unknown): Need[] => (Array.isArray(value) ? (value as Need[]) : []);
const asRoutines = (value: unknown): Routine[] => (Array.isArray(value) ? (value as Routine[]) : []);
const slug = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
const nameOf = (name: string | null | undefined) => (name?.trim() || 'Someone').slice(0, 100);

/** A template as a card in a list or on a Brick: who made it and what it starts with, never how it is used or by how many. */
export interface TemplateCard {
  id: string;
  /** The Brick it was shared from: the card of that Brick is where "Use template" sits. */
  brickId: string;
  name: string;
  description: string | null;
  look: string | null;
  firstThing: string | null;
  maker: { name: string };
  version: number;
  starred: boolean;
  /** The viewer made it. */
  mine: boolean;
}

export interface NeedView extends Need {
  /** The person has it (before creating) or the Brick has it (after). Confirmed again during setup. */
  ready: boolean;
}

/** The look before creating: what the new Brick starts with, what stays with the original, and what it still needs. */
export interface TemplatePreview extends TemplateCard {
  instructions: string | null;
  needs: NeedView[];
  /** The main job lacks something: the person can still create it knowing what is missing. */
  setupRequired: boolean;
  /** What comes along switched off. */
  routines: Routine[];
  staysWithOriginal: readonly string[];
}

type Loaded = BrickTemplate & { maker: { name: string | null }; bot: { id: string } };

async function currentVersions(templates: BrickTemplate[], db: Db): Promise<Map<string, BrickTemplateVersion>> {
  if (templates.length === 0) return new Map();
  const versions = await db.brickTemplateVersion.findMany({ where: { OR: templates.map((template) => ({ templateId: template.id, number: template.currentVersion })) } });
  return new Map(versions.map((version) => [version.templateId, version]));
}

async function starredAmong(viewerId: string, templateIds: string[], db: Db): Promise<Set<string>> {
  if (templateIds.length === 0) return new Set();
  const stars = await db.brickTemplateStar.findMany({ where: { userId: viewerId, templateId: { in: templateIds } }, select: { templateId: true } });
  return new Set(stars.map((star) => star.templateId));
}

function cardOf(template: Loaded, version: BrickTemplateVersion, viewerId: string, starred: boolean): TemplateCard {
  return {
    id: template.id,
    brickId: template.botId,
    name: version.name,
    description: version.description,
    look: version.characterTextureId,
    firstThing: version.firstThing,
    maker: { name: nameOf(template.maker.name) },
    version: template.currentVersion,
    starred,
    mine: template.makerId === viewerId,
  };
}

const WITH_MAKER = { maker: { select: { name: true } }, bot: { select: { id: true } } } as const;

async function cards(templates: Loaded[], viewerId: string, db: Db = prisma): Promise<TemplateCard[]> {
  const [versions, starred] = await Promise.all([currentVersions(templates, db), starredAmong(viewerId, templates.map((template) => template.id), db)]);
  return templates.flatMap((template) => {
    const version = versions.get(template.id);
    return version ? [cardOf(template, version, viewerId, starred.has(template.id))] : [];
  });
}

/* ------------------------------ what a person has ------------------------------ */

function appMatches(connection: Pick<AppConnection, 'catalogKey' | 'providerToolkit' | 'name'>, key: string): boolean {
  if (key.startsWith('link:')) return slug(connection.name) === key.slice(5);
  return connection.catalogKey === key || connection.providerToolkit === key;
}

/** What a person has before they make the Brick: the apps they connected (signed in and working). Never a computer: a new Brick has none. */
async function readyForPerson(personId: string, needs: Need[], db: Db): Promise<NeedView[]> {
  const connections = needs.some((need) => need.kind === 'app') ? await db.appConnection.findMany({ where: { ownerId: personId } }) : [];
  return needs.map((need) => ({
    ...need,
    ready: need.kind === 'app' && connections.some((connection) => appMatches(connection, need.key) && connectedState(connection).connected),
  }));
}

/** What a Brick has now: the apps it may use on connections that work, and whether its computer is on. */
export async function readyOnBrick(botId: string, needs: Need[], db: Db = prisma): Promise<NeedView[]> {
  const [servers, computer] = await Promise.all([
    needs.some((need) => need.kind === 'app')
      ? db.botMcpServer.findMany({ where: { botId, enabled: true }, include: { connection: true } })
      : Promise.resolve([]),
    needs.some((need) => need.kind === 'computer') ? db.brickComputer.findUnique({ where: { botId }, select: { enabled: true } }) : Promise.resolve(null),
  ]);
  return needs.map((need) => {
    if (need.kind === 'computer') return { ...need, ready: !!computer?.enabled };
    const ready = servers.some((server) => {
      if (server.connection) return appMatches(server.connection, need.key) && connectedState(server.connection).connected;
      return need.key.startsWith('link:') && slug(server.name) === need.key.slice(5);
    });
    return { ...need, ready };
  });
}

const setupRequired = (needs: NeedView[]) => needs.some((need) => need.required && !need.ready);

/* ------------------------------ looking and starring ------------------------------ */

/** A template's look before creating, for anyone signed in who may open it (a shared link works for everyone signed in). Null when it is not there to open. */
export async function previewTemplate(templateId: string, viewerId: string): Promise<TemplatePreview | null> {
  const template = await prisma.brickTemplate.findFirst({ where: { id: templateId, ...OPEN }, include: WITH_MAKER });
  if (!template) return null;
  const version = await prisma.brickTemplateVersion.findUnique({ where: { templateId_number: { templateId: template.id, number: template.currentVersion } } });
  if (!version) return null;
  const starred = await starredAmong(viewerId, [template.id], prisma);
  const needs = await readyForPerson(viewerId, asNeeds(version.needs), prisma);
  return {
    ...cardOf(template, version, viewerId, starred.has(template.id)),
    instructions: version.chatInstructions,
    needs,
    setupRequired: setupRequired(needs),
    routines: asRoutines(version.routines),
    staysWithOriginal: NEVER_CARRIED,
  };
}

/** The card of a Brick someone meets: its template, when it is shared with everyone. A template shared by link only is never on a card. */
export async function templateOfBrick(botId: string, viewerId: string): Promise<TemplateCard | null> {
  const template = await prisma.brickTemplate.findFirst({ where: { botId, audience: 'everyone', ...OPEN }, include: WITH_MAKER });
  return template ? (await cards([template], viewerId))[0] ?? null : null;
}

/** Star keeps a template for later. Null when it is not there to open. Starring twice is the same star. */
export async function starTemplate(templateId: string, viewerId: string): Promise<boolean> {
  const open = await prisma.brickTemplate.findFirst({ where: { id: templateId, ...OPEN }, select: { id: true } });
  if (!open) return false;
  await prisma.brickTemplateStar.upsert({ where: { userId_templateId: { userId: viewerId, templateId } }, create: { userId: viewerId, templateId }, update: {} });
  return true;
}

/** Takes a star off, even from a template that is no longer shared. */
export async function unstarTemplate(templateId: string, viewerId: string): Promise<void> {
  await prisma.brickTemplateStar.deleteMany({ where: { userId: viewerId, templateId } });
}

export interface TemplateLists {
  starred: TemplateCard[];
  picks: TemplateCard[];
  met: TemplateCard[];
}

/**
 * The three short lists under "Start from a template": the ones the person starred, a few picked by Universe, and Bricks they
 * have met (talked with) that share one. Only what the viewer may open, each as long as the Limits setting says. A template
 * shared by link only is on their Starred list if they starred it, and nowhere else. Popular and Trending are not here: they
 * arrive with the Community shelf, under its own rules.
 */
export async function templateLists(viewerId: string): Promise<TemplateLists> {
  const take = (await getBrickLimits()).templateList;
  const [stars, picked, metIds] = await Promise.all([
    prisma.brickTemplateStar.findMany({ where: { userId: viewerId, template: OPEN }, include: { template: { include: WITH_MAKER } }, orderBy: [{ createdAt: 'desc' }, { templateId: 'asc' }], take }),
    prisma.brickTemplate.findMany({ where: { audience: 'everyone', pickedAt: { not: null }, ...OPEN }, include: WITH_MAKER, orderBy: [{ pickedAt: 'desc' }, { id: 'asc' }], take }),
    prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT t."id" FROM "brick_templates" t
      JOIN "bots" b ON b."id" = t."bot_id"
      WHERE t."audience" = 'everyone' AND t."stopped_at" IS NULL AND b."deleted_at" IS NULL AND t."maker_id" <> ${viewerId}
        AND EXISTS (SELECT 1 FROM "bots_conversations_recent" c WHERE c."bot_id" = t."bot_id" AND c."user_id" = ${viewerId})
      ORDER BY (SELECT max(c."ended_at") FROM "bots_conversations_recent" c WHERE c."bot_id" = t."bot_id" AND c."user_id" = ${viewerId}) DESC, t."id"
      LIMIT ${take}`),
  ]);
  const metTemplates = metIds.length ? await prisma.brickTemplate.findMany({ where: { id: { in: metIds.map((row) => row.id) } }, include: WITH_MAKER }) : [];
  const order = new Map(metIds.map((row, index) => [row.id, index]));
  metTemplates.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return {
    starred: await cards(stars.map((star) => star.template), viewerId),
    picks: await cards(picked, viewerId),
    met: await cards(metTemplates, viewerId),
  };
}

/** Universe picks a template for the "a few picks" list, or takes it off. Only a template that is shared with everyone can be picked. */
export async function pickTemplate(templateId: string, adminId: string, picked: boolean): Promise<'ok' | 'not_found' | 'not_for_everyone'> {
  const template = await prisma.brickTemplate.findFirst({ where: { id: templateId, ...OPEN }, select: { id: true, audience: true } });
  if (!template) return 'not_found';
  if (picked && template.audience !== 'everyone') return 'not_for_everyone';
  await prisma.brickTemplate.update({ where: { id: template.id }, data: picked ? { pickedAt: new Date(), pickedById: adminId } : { pickedAt: null, pickedById: null } });
  return 'ok';
}

/* ------------------------------ routines that arrive switched off ------------------------------ */

/**
 * Gives a Brick the routines a template came with, SWITCHED OFF: paused by the template, nothing due, so none can run until
 * the owner sets them up and turns them on (see templateRoutineGate). They count toward the person's goals and tasks like any
 * other, so the ones that do not fit under the setting are left out, and how many is said. Reads the time zone the person kept;
 * until one is kept the routine holds a placeholder zone that is replaced when they turn it on.
 */
export async function bringRoutines(tx: Prisma.TransactionClient, botId: string, ownerId: string, routines: Routine[], itemsPerPerson: number): Promise<{ added: number; leftOut: number }> {
  if (routines.length === 0) return { added: 0, leftOut: 0 };
  const kept = (await tx.userPreference.findUnique({ where: { userId_key: { userId: ownerId, key: TIME_ZONE_KEY } }, select: { value: true } }))?.value;
  const timeZone = isTimeZone(kept) ? kept : 'UTC';
  const have = await tx.brickItem.count({ where: { ownerId, parentId: null, state: { in: ['on', 'paused'] } } });
  const room = Math.max(0, itemsPerPerson - have);
  let added = 0;
  for (const routine of routines.slice(0, room)) {
    await tx.brickItem.create({
      data: {
        ownerId,
        botId,
        kind: routine.kind,
        words: routine.words,
        condition: routine.kind === 'watch' ? routine.condition : null,
        cadence: routine.cadence as unknown as Prisma.InputJsonValue,
        timeZone,
        nextDueAt: null,
        state: 'paused',
        pausedBy: 'template',
        setBy: 'you',
      },
    });
    added += 1;
  }
  return { added, leftOut: routines.length - added };
}

export type Gate = { ok: true; timeZone: string } | { ok: false; status: 409 | 422; code: 'needs_time_zone' | 'needs_setup'; error: string };

/**
 * What must be true before a routine that came with a template is turned on: the person's time zone is kept (it is read on
 * their clock, never the maker's), and what the template said the Brick needs is there. Asked inside the transaction of the
 * item's own change. This is the only door a template's routine goes through to run.
 */
export async function templateRoutineGate(tx: Prisma.TransactionClient, botId: string, ownerId: string): Promise<Gate> {
  const kept = (await tx.userPreference.findUnique({ where: { userId_key: { userId: ownerId, key: TIME_ZONE_KEY } }, select: { value: true } }))?.value;
  if (!isTimeZone(kept)) return { ok: false, status: 422, code: 'needs_time_zone', error: 'No time zone is kept for this person yet' };
  const use = await tx.brickTemplateUse.findUnique({ where: { botId }, select: { templateId: true, versionNumber: true } });
  if (use?.templateId) {
    const version = await tx.brickTemplateVersion.findUnique({ where: { templateId_number: { templateId: use.templateId, number: use.versionNumber } }, select: { needs: true } });
    const missing = (await readyOnBrick(botId, asNeeds(version?.needs), tx)).filter((need) => need.required && !need.ready);
    if (missing.length > 0) return { ok: false, status: 409, code: 'needs_setup', error: `Set up ${missing.map((need) => need.label).join(', ')} first` };
  }
  return { ok: true, timeZone: kept };
}

/* ------------------------------ using one ------------------------------ */

export const fromTemplateSchema = z
  .object({
    /** Its own name. None: the template's. */
    name: z.string().trim().min(1, 'name cannot be empty').max(100, 'name must be at most 100 characters').optional(),
  })
  .strict();

/** "Made from", for a Brick's page: who made the template it started from. The maker's name stays after the template goes. */
export interface MadeFrom {
  templateName: string;
  maker: { name: string };
  /** The version this Brick last took. */
  version: number;
  /** The template is still shared. */
  shared: boolean;
}

export interface Setup {
  needs: NeedView[];
  /** The main job still lacks something: the Brick's page opens on "Setup required" and names it. */
  setupRequired: boolean;
  /** Routines that came with it and are still switched off. */
  routinesOff: number;
}

export type Used = { ok: true; brick: BrickCard; madeFrom: MadeFrom; setup: Setup; routines: { added: number; leftOut: number } } | { ok: false; status: 404; error: string };

/**
 * "Create Brick": the viewer's own new Brick from a template. It is theirs, has no room, runs on Universe AI, and starts from
 * the version the template is at now: its look (or the next colour they have not used when the maker left the look out), its
 * line, its instructions and the first thing to try as its first line. It copies no memory, chat, app, key, sign-in, grant,
 * goal, file or computer, because none of them is in a template.
 */
export async function makeBrickFromTemplate(viewerId: string, templateId: string, input: z.infer<typeof fromTemplateSchema>): Promise<Used> {
  const limits = await getBrickLimits();
  return prisma.$transaction(async (tx) => {
    // One at a time per person, like their other Bricks and routines
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`brick-items:${viewerId}`}))`;
    const template = await tx.brickTemplate.findFirst({ where: { id: templateId, ...OPEN }, include: WITH_MAKER });
    const version = template ? await tx.brickTemplateVersion.findUnique({ where: { templateId_number: { templateId: template.id, number: template.currentVersion } } }) : null;
    if (!template || !version) return { ok: false as const, status: 404 as const, error: 'Template not found' };

    const brick = await makeBrick(
      viewerId,
      { name: input.name ?? version.name, description: version.description, chatInstructions: version.chatInstructions, characterTextureId: version.characterTextureId, hello: version.firstThing },
      tx,
    );
    const makerName = nameOf(template.maker.name);
    await tx.brickTemplateUse.create({ data: { botId: brick.id, templateId: template.id, versionNumber: version.number, makerId: template.makerId, makerName, templateName: version.name } });
    const routines = await bringRoutines(tx, brick.id, viewerId, asRoutines(version.routines), limits.itemsPerPerson);
    const needs = await readyOnBrick(brick.id, asNeeds(version.needs), tx);
    return {
      ok: true as const,
      brick,
      madeFrom: { templateName: version.name, maker: { name: makerName }, version: version.number, shared: true },
      setup: { needs, setupRequired: setupRequired(needs), routinesOff: routines.added },
      routines,
    };
  });
}

/* ------------------------------ a Brick made from a template ------------------------------ */

export const UPDATE_FIELDS = ['description', 'look', 'instructions', 'firstThing', 'routines'] as const;
export type UpdateField = (typeof UPDATE_FIELDS)[number];

/** One thing the maker changed that this Brick can take: what it has now, and what the template says now. */
export type Change =
  | { field: Exclude<UpdateField, 'routines'>; mine: string | null; theirs: string }
  | { field: 'routines'; mine: null; theirs: Routine[] };

export interface TemplateUpdate {
  /** The version the template is at now. */
  version: number;
  changes: Change[];
  /** What the template says the Brick needs now, so the review can say it. */
  needs: NeedView[];
}

export interface MadeFromView {
  madeFrom: MadeFrom;
  setup: Setup;
  /** "Template updated": null when nothing new is offered. */
  update: TemplateUpdate | null;
}

const routineKey = (routine: Routine) => JSON.stringify([routine.kind, routine.words.trim(), routine.condition ?? null]);

type BrickFields = { description: string | null; characterTextureId: string | null; chatInstructions: string | null; hello: string | null };

function changesBetween(taken: BrickTemplateVersion, latest: BrickTemplateVersion, brick: BrickFields, have: Set<string>): Change[] {
  const changes: Change[] = [];
  const text = (field: 'description' | 'instructions' | 'firstThing' | 'look', before: string | null, now: string | null, mine: string | null) => {
    // A maker who took a part out leaves what the Brick has; a part that changed and still differs from the Brick's own is offered
    if (now !== null && now !== before && now !== mine) changes.push({ field, mine, theirs: now });
  };
  text('description', taken.description, latest.description, brick.description);
  text('look', taken.characterTextureId, latest.characterTextureId, brick.characterTextureId);
  text('instructions', taken.chatInstructions, latest.chatInstructions, brick.chatInstructions);
  text('firstThing', taken.firstThing, latest.firstThing, brick.hello);
  const before = new Set(asRoutines(taken.routines).map(routineKey));
  const fresh = asRoutines(latest.routines).filter((routine) => !before.has(routineKey(routine)) && !have.has(routineKey(routine)));
  if (fresh.length > 0) changes.push({ field: 'routines', mine: null, theirs: fresh });
  return changes;
}

async function routinesOf(botId: string, db: Db): Promise<Set<string>> {
  const rows = await db.brickItem.findMany({ where: { botId, state: { in: ['on', 'paused'] } }, select: { kind: true, words: true, condition: true } });
  return new Set(rows.filter((row) => (['reminder', 'schedule', 'watch'] as string[]).includes(row.kind)).map((row) => routineKey({ kind: row.kind as RoutineKind, words: row.words, condition: row.kind === 'watch' ? row.condition : null, cadence: { type: 'none' } as Cadence })));
}

async function readUpdate(botId: string, use: { templateId: string | null; versionNumber: number }, db: Db): Promise<{ template: BrickTemplate; taken: BrickTemplateVersion; latest: BrickTemplateVersion; changes: Change[] } | null> {
  if (!use.templateId) return null;
  // Only a template that is still shared offers an update: stopping sharing leaves every Brick as it is
  const template = await db.brickTemplate.findFirst({ where: { id: use.templateId, ...OPEN } });
  if (!template || template.currentVersion <= use.versionNumber) return null;
  const [taken, latest, brick, have] = await Promise.all([
    db.brickTemplateVersion.findUnique({ where: { templateId_number: { templateId: template.id, number: use.versionNumber } } }),
    db.brickTemplateVersion.findUnique({ where: { templateId_number: { templateId: template.id, number: template.currentVersion } } }),
    db.bot.findUnique({ where: { id: botId }, select: { description: true, characterTextureId: true, chatInstructions: true, hello: true } }),
    routinesOf(botId, db),
  ]);
  if (!taken || !latest || !brick) return null;
  return { template, taken, latest, changes: changesBetween(taken, latest, brick, have) };
}

/** A Brick made from a template, on its page: where it came from, what it still needs, and a template update waiting for review. Null for any other Brick, and for anyone but its owner. */
export async function madeFromView(botId: string, ownerId: string): Promise<MadeFromView | null> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { roomId: true, ownerId: true, deletedAt: true } });
  if (!bot || !ownsBrick(bot, ownerId)) return null;
  const use = await prisma.brickTemplateUse.findUnique({ where: { botId }, include: { template: { select: { id: true, stoppedAt: true, bot: { select: { deletedAt: true } } } } } });
  if (!use) return null;
  const taken = use.templateId ? await prisma.brickTemplateVersion.findUnique({ where: { templateId_number: { templateId: use.templateId, number: use.versionNumber } } }) : null;
  const needs = await readyOnBrick(botId, asNeeds(taken?.needs));
  const off = await prisma.brickItem.count({ where: { botId, state: 'paused', pausedBy: 'template' } });
  const read = await readUpdate(botId, use, prisma);
  const offered = read && read.changes.length > 0 ? read : null;
  return {
    madeFrom: { templateName: use.templateName, maker: { name: use.makerName }, version: use.versionNumber, shared: !!use.template && !use.template.stoppedAt && !use.template.bot.deletedAt },
    setup: { needs, setupRequired: setupRequired(needs), routinesOff: off },
    update: offered ? { version: offered.template.currentVersion, changes: offered.changes, needs: await readyOnBrick(botId, asNeeds(offered.latest.needs)) } : null,
  };
}

export const takeUpdateSchema = z
  .object({
    /** The version the person read. */
    version: z.number().int().min(1),
    /** The parts they take. None: they keep their Brick as it is, and the offer is closed. */
    take: z.array(z.enum(UPDATE_FIELDS)).max(UPDATE_FIELDS.length),
  })
  .strict();

export type Taken = { ok: true; view: MadeFromView; routines: { added: number; leftOut: number } } | { ok: false; status: 404 | 409 | 422; error: string; code?: 'changed' | 'not_offered' };

/**
 * "Template updated", the owner's choice: they take some parts, all of them, or none. Only the parts they name are applied; the
 * rest of their Brick is never touched, and nothing a template adds to routines runs until they turn it on. Taking none closes the offer
 * for that version. Asked for a version that is no longer the latest, nothing is applied and the answer says so.
 */
export async function takeUpdate(botId: string, ownerId: string, input: z.infer<typeof takeUpdateSchema>): Promise<Taken> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { roomId: true, ownerId: true, deletedAt: true } });
  if (!bot || !ownsBrick(bot, ownerId)) return { ok: false, status: 404, error: 'Brick not found' };
  const limits = await getBrickLimits();
  const done = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`brick-items:${ownerId}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`brick-template-take:${botId}`}))`;
    const use = await tx.brickTemplateUse.findUnique({ where: { botId } });
    if (!use) return { ok: false as const, status: 404 as const, error: 'Brick not found' };
    const read = await readUpdate(botId, use, tx);
    if (!read) return { ok: false as const, status: 409 as const, code: 'not_offered' as const, error: 'There is no update to take' };
    if (read.template.currentVersion !== input.version) return { ok: false as const, status: 409 as const, code: 'changed' as const, error: 'The template changed again. Read it again.' };
    const offered = new Map(read.changes.map((change) => [change.field, change]));
    const wanted = [...new Set(input.take)];
    if (wanted.some((field) => !offered.has(field))) return { ok: false as const, status: 422 as const, code: 'not_offered' as const, error: 'Part of what you chose is not in this update' };

    const data: Prisma.BotUncheckedUpdateInput = { updatedById: ownerId };
    for (const field of wanted) {
      const change = offered.get(field)!;
      if (change.field === 'routines') continue;
      if (field === 'description') data.description = change.theirs;
      if (field === 'look') data.characterTextureId = change.theirs;
      if (field === 'instructions') data.chatInstructions = change.theirs;
      if (field === 'firstThing') data.hello = change.theirs;
    }
    if (Object.keys(data).length > 1) await tx.bot.update({ where: { id: botId }, data });
    const routineChange = wanted.includes('routines') ? offered.get('routines') : undefined;
    const routines = routineChange && routineChange.field === 'routines' ? await bringRoutines(tx, botId, ownerId, routineChange.theirs, limits.itemsPerPerson) : { added: 0, leftOut: 0 };
    await tx.brickTemplateUse.update({ where: { botId }, data: { versionNumber: read.template.currentVersion, templateName: read.latest.name } });
    return { ok: true as const, routines };
  });
  if (!done.ok) return done;
  return { ok: true, view: (await madeFromView(botId, ownerId))!, routines: done.routines };
}
