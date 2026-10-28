import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { checkBotAccess } from '@/lib/bot-access';
import { loadBotPrivacy } from '@/lib/bot-privacy';
import { findUserByIdentifier } from '@/lib/user-identifier';
import { artifactFiles, type ArtifactFiles } from '@/lib/artifact-storage';
import { getServerLimits } from '@/lib/bot-limits';
import { artifactBytes, type ArtifactLimits } from '@/lib/bot-limit-values';
import {
  ARTIFACT_KINDS,
  ArtifactError,
  CHANGE_SCOPES,
  GUEST_KEEP_MS,
  MAX_NAME_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  OPEN_SCOPES,
  applyEdits,
  byteLength,
  canAskForChange,
  canOpen,
  checkContent,
  checkVersionRoom,
  cleanLine,
  clipText,
  fileTypeOf,
  hasExpired,
  isOneOf,
  isOwner,
  newFileKey,
  type ArtifactEdit,
  type ArtifactKind,
  type Asker,
  type ChangeScope,
  type ChatKind,
  type OpenScope,
} from '@/lib/artifacts';

/**
 * Live artifacts (game #1422, Orbit #622): the list of what bots made for people, the versions of each, and who may
 * open or change them. The bot server calls make, change and read (with the chat the person asked in); the game calls
 * open, versions, share, restore and copy (naming the person and whether they are in the chat).
 */

/** A person as the callers name them. A guest has no account: nothing is kept for them beyond a day. */
export interface Person {
  signedIn: boolean;
  identifier?: string | null;
  name?: string | null;
}

/** A chat, by the id the bot server and the game both use for it. */
export interface Chat {
  kind: ChatKind;
  ref: string;
}

export interface Context {
  files: ArtifactFiles;
  now: Date;
  /** The artifact limits to apply (#666); read from the super admin's settings when not given. */
  limits?: ArtifactLimits;
}

/** The size and version limits a super admin set (#666). */
async function limitsOf(ctx: Context): Promise<{ maxBytes: number; maxVersions: number }> {
  const limits = ctx.limits ?? (await getServerLimits()).artifacts;
  return { maxBytes: artifactBytes(limits), maxVersions: limits.versions };
}

/** Most artifacts a bot is told about at once. */
const LIST_IN_CHAT_LIMIT = 20;

const defaultContext = (): Context => ({ files: artifactFiles, now: new Date() });

interface Who extends Asker {
  /** The name to show for the version they asked for. */
  name: string | null;
}

async function resolvePerson(person: Person, inChat: boolean): Promise<Who> {
  const user = person.signedIn && person.identifier ? await findUserByIdentifier(person.identifier) : null;
  const account = user && !user.isGuest ? user : null;
  return { userId: account?.id ?? null, inChat, name: cleanLine(person.name ?? account?.name, MAX_NAME_LENGTH) };
}

const ARTIFACT_INCLUDE = { owner: { select: { name: true } } } as const;
type ArtifactRow = Prisma.ArtifactGetPayload<{ include: typeof ARTIFACT_INCLUDE }>;

async function loadArtifact(id: string, now: Date): Promise<ArtifactRow> {
  const artifact = await prisma.artifact.findUnique({ where: { id }, include: ARTIFACT_INCLUDE });
  // An artifact that has run out is gone for everyone, and a missing one looks the same as one nobody may open
  if (!artifact || hasExpired(artifact, now)) throw new ArtifactError('not_found', 404, 'No such artifact.');
  return artifact;
}

export interface ArtifactView {
  id: string;
  title: string;
  kind: string;
  makerBotId: string;
  makerName: string;
  /** The person who asked for it; null for a guest's. */
  owner: { name: string | null } | null;
  version: number;
  openScope: string;
  changeScope: string;
  /** The kind of chat it was made in; a copy has none. */
  chatKind: string | null;
  copiedFromId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Set for a guest's artifact: when it goes. */
  expiresAt: string | null;
}

function viewOf(artifact: ArtifactRow): ArtifactView {
  return {
    id: artifact.id,
    title: artifact.title,
    kind: artifact.kind,
    makerBotId: artifact.makerBotId,
    makerName: artifact.makerName,
    owner: artifact.ownerId ? { name: artifact.owner?.name ?? null } : null,
    version: artifact.latestVersion,
    openScope: artifact.openScope,
    changeScope: artifact.changeScope,
    chatKind: artifact.chatKind,
    copiedFromId: artifact.copiedFromId,
    createdAt: artifact.createdAt.toISOString(),
    updatedAt: artifact.updatedAt.toISOString(),
    expiresAt: artifact.expiresAt?.toISOString() ?? null,
  };
}

export interface VersionView {
  number: number;
  summary: string | null;
  askedByName: string | null;
  sizeBytes: number;
  createdAt: string;
  /** Where the file is served from, for the locked box. */
  url: string;
}

type VersionRow = { number: number; summary: string | null; askedByName: string | null; sizeBytes: number; createdAt: Date; fileKey: string };

/** What a bot is told about a version: the same, without the file's address (only the game opens the file). */
export type BotVersionView = Omit<VersionView, 'url'>;

function botVersionView(row: VersionRow): BotVersionView {
  return {
    number: row.number,
    summary: row.summary,
    askedByName: row.askedByName,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

function versionView(row: VersionRow, files: ArtifactFiles): VersionView {
  return { ...botVersionView(row), url: files.urlFor(row.fileKey) };
}

/** What the person who is looking may do, for the buttons the game shows. */
export interface Rights {
  owner: boolean;
  /** Ask a bot to change it. */
  change: boolean;
  /** Share, and restore an older version: the owner of a kept artifact. */
  manage: boolean;
  /** Make a copy: needs an account. */
  copy: boolean;
}

function rightsOf(artifact: ArtifactRow, who: Who, now: Date): Rights {
  const owner = isOwner(artifact, who);
  return {
    owner,
    change: canAskForChange(artifact, who, who.inChat, now),
    manage: owner,
    copy: who.userId !== null,
  };
}

function requireOpen(artifact: ArtifactRow, who: Who, now: Date): void {
  if (!canOpen(artifact, who, now)) throw new ArtifactError('not_found', 404, 'No such artifact.');
}

function requireOwner(artifact: ArtifactRow, who: Who): void {
  if (!isOwner(artifact, who)) throw new ArtifactError('owner_only', 403, 'Only the owner can do this.');
}

// ---- The bot server: make, change, read -------------------------------------------------------------------------

interface BotCall {
  botId: string;
  person: Person;
  chat: Chat;
}

/**
 * What every bot call goes through first: the bot exists, the person may use it the way they asked in this chat (the
 * same answer as /api/bots/:id/access), and the bot chat telemetry switch. `hidden` goes back with every answer, so the
 * bot server keeps the artifact's text out of PostHog and Sentry when the bot's chats are hidden. Orbit logs no content.
 */
async function passBotGate(call: BotCall): Promise<{ botName: string; hidden: boolean }> {
  const access = await checkBotAccess({
    botId: call.botId,
    action: call.chat.kind === 'dm' ? 'dm' : 'chat',
    person: { signedIn: call.person.signedIn, identifier: call.person.identifier },
  });
  if (!access) throw new ArtifactError('bot_not_found', 404, 'No such bot.');
  if (!access.allowed) throw new ArtifactError('not_allowed', 403, access.reason ?? 'This person cannot use this bot.');
  const [bot, privacy] = await Promise.all([
    prisma.bot.findUnique({ where: { id: call.botId }, select: { name: true } }),
    loadBotPrivacy(call.botId),
  ]);
  if (!bot) throw new ArtifactError('bot_not_found', 404, 'No such bot.');
  return { botName: bot.name, hidden: privacy?.hidden === true };
}

function inThisChat(artifact: { chatKind: string | null; chatRef: string | null }, chat: Chat): boolean {
  return artifact.chatRef !== null && artifact.chatRef === chat.ref && artifact.chatKind === chat.kind;
}

export interface MakeInput extends BotCall {
  title: string;
  kind: ArtifactKind;
  content: string;
  summary?: string | null;
}

export interface Made {
  artifact: ArtifactView;
  version: BotVersionView;
  hidden: boolean;
}

/**
 * Stores the file, then runs the database write; the file goes again only if that write fails. Anything after the write
 * (reading it back, clearing old artifacts) must stay outside, or an error there would delete the file of a version
 * that is already committed.
 */
async function storing<T>(files: ArtifactFiles, fileKey: string, kind: ArtifactKind, content: string, write: () => Promise<T>): Promise<T> {
  await files.put(fileKey, content, fileTypeOf(kind).contentType);
  try {
    return await write();
  } catch (error) {
    await files.remove([fileKey]).catch(() => undefined);
    throw error;
  }
}

export async function makeArtifact(input: MakeInput, ctx: Context = defaultContext()): Promise<Made> {
  const { files, now } = ctx;
  const title = cleanLine(input.title, MAX_TITLE_LENGTH);
  if (!title) throw new ArtifactError('title_required', 422, 'An artifact needs a title.');
  if (!isOneOf(ARTIFACT_KINDS, input.kind)) throw new ArtifactError('invalid_kind', 422, 'Unknown kind of artifact.');
  const { maxBytes } = await limitsOf(ctx);
  checkContent(input.content, maxBytes);
  const { botName, hidden } = await passBotGate(input);
  const who = await resolvePerson(input.person, true);

  const id = randomUUID();
  const fileKey = newFileKey(id, 1, input.kind);
  const artifact = await storing(files, fileKey, input.kind, input.content, () =>
    prisma.artifact.create({
      data: {
        id,
        ownerId: who.userId,
        makerBotId: input.botId,
        makerName: clipText(botName, MAX_NAME_LENGTH),
        title,
        kind: input.kind,
        chatKind: input.chat.kind,
        chatRef: input.chat.ref,
        // Nothing is kept for a guest beyond a day, and anyone in their chat may ask for a change meanwhile
        changeScope: who.userId ? 'owner' : 'openers',
        expiresAt: who.userId ? null : new Date(now.getTime() + GUEST_KEEP_MS),
        versions: {
          create: {
            number: 1,
            summary: cleanLine(input.summary, MAX_SUMMARY_LENGTH) ?? 'First version',
            askedById: who.userId,
            askedByName: who.name,
            fileKey,
            sizeBytes: byteLength(input.content),
          },
        },
      },
      include: { ...ARTIFACT_INCLUDE, versions: true },
    }),
  );
  await pruneExpired(ctx).catch((error) => console.error('Could not clear expired artifacts:', error));
  return { artifact: viewOf(artifact), version: botVersionView(artifact.versions[0]), hidden };
}

export interface ChangeInput extends BotCall {
  artifactId: string;
  /** The version the bot read before it changed anything; a newer one in between stops the change. */
  baseVersion?: number | null;
  /** Small edits to the latest version, or the whole new file; exactly one of them. */
  edits?: ArtifactEdit[] | null;
  content?: string | null;
  summary?: string | null;
  title?: string | null;
}

export async function changeArtifact(input: ChangeInput, ctx: Context = defaultContext()): Promise<Made> {
  const { files, now } = ctx;
  const hasEdits = Array.isArray(input.edits) && input.edits.length > 0;
  const hasContent = typeof input.content === 'string';
  if (hasEdits === hasContent) throw new ArtifactError('edits_or_content', 422, 'Send small edits or the whole new file, not both and not neither.');
  const { hidden } = await passBotGate(input);
  const who = await resolvePerson(input.person, true);
  const artifact = await loadArtifact(input.artifactId, now);
  if (!canAskForChange(artifact, who, inThisChat(artifact, input.chat), now)) {
    // Someone who cannot even open it hears the same as for an artifact that is not there
    if (!canOpen(artifact, { ...who, inChat: inThisChat(artifact, input.chat) }, now)) throw new ArtifactError('not_found', 404, 'No such artifact.');
    throw new ArtifactError('change_not_allowed', 403, 'The owner has not allowed changes from this person.');
  }
  const { maxBytes, maxVersions } = await limitsOf(ctx);
  checkVersionRoom(artifact.latestVersion, maxVersions);
  if (input.baseVersion != null && input.baseVersion !== artifact.latestVersion) {
    throw new ArtifactError('stale_version', 409, `It is on version ${artifact.latestVersion} now; read it again and send the change on that.`);
  }

  const kind = artifact.kind as ArtifactKind;
  const latest = await prisma.artifactVersion.findUnique({ where: { artifactId_number: { artifactId: artifact.id, number: artifact.latestVersion } } });
  if (!latest) throw new ArtifactError('file_missing', 502, 'The latest version could not be found.');
  const content = hasEdits ? applyEdits(await files.get(latest.fileKey), input.edits as ArtifactEdit[], maxBytes) : (input.content as string);
  checkContent(content, maxBytes);

  const next = artifact.latestVersion + 1;
  const fileKey = newFileKey(artifact.id, next, kind);
  const title = cleanLine(input.title, MAX_TITLE_LENGTH);
  const row = await storing(files, fileKey, kind, content, () =>
    prisma.$transaction(async (tx) => {
      // The one who gets here first moves the version on; anyone who read the same version before fails here
      const moved = await tx.artifact.updateMany({
        where: { id: artifact.id, latestVersion: artifact.latestVersion },
        data: {
          latestVersion: next,
          ...(title ? { title } : {}),
          ...(artifact.ownerId === null ? { expiresAt: new Date(now.getTime() + GUEST_KEEP_MS) } : {}),
        },
      });
      if (moved.count !== 1) throw new ArtifactError('stale_version', 409, 'Someone changed it at the same moment; read it again and send the change on that.');
      return tx.artifactVersion.create({
        data: {
          artifactId: artifact.id,
          number: next,
          summary: cleanLine(input.summary, MAX_SUMMARY_LENGTH) ?? 'Changed',
          askedById: who.userId,
          askedByName: who.name,
          fileKey,
          sizeBytes: byteLength(content),
        },
      });
    }),
  );
  const fresh = await loadArtifact(artifact.id, now);
  return { artifact: viewOf(fresh), version: botVersionView(row), hidden };
}

export interface ReadInput extends BotCall {
  artifactId: string;
  /** Which version; the latest when left out. */
  version?: number | null;
}

export interface Read extends Made {
  content: string;
}

export async function readArtifact(input: ReadInput, ctx: Context = defaultContext()): Promise<Read> {
  const { files, now } = ctx;
  const { hidden } = await passBotGate(input);
  const who = await resolvePerson(input.person, true);
  const artifact = await loadArtifact(input.artifactId, now);
  requireOpen(artifact, { ...who, inChat: inThisChat(artifact, input.chat) }, now);
  const row = await findVersion(artifact, input.version);
  return { artifact: viewOf(artifact), version: botVersionView(row), content: await files.get(row.fileKey), hidden };
}

/**
 * The artifacts made in this chat (by any bot in it) that the person may open, the most recently changed first: how a bot finds
 * the one "make the buttons bigger" is about, in a later message or after a restart. An artifact belongs to the person who
 * asked, so what a bot may do with it is what that person may, not which bot made it.
 */
export async function listArtifactsInChat(input: BotCall, ctx: Context = defaultContext()): Promise<{ artifacts: ArtifactView[]; hidden: boolean }> {
  const { now } = ctx;
  const { hidden } = await passBotGate(input);
  const who = await resolvePerson(input.person, true);
  pruneSometimes(ctx);
  // What was made in this chat, and the asking person's own from any other chat, so a bot in a direct message finds what
  // they started in nearby chat and the other way round. Only their own: nobody else's artifact is listed outside its chat.
  // This chat's come first, so a person with many artifacts elsewhere never pushes the chat's own out of the list.
  const include = ARTIFACT_INCLUDE;
  const orderBy = { updatedAt: 'desc' } as const;
  const take = LIST_IN_CHAT_LIMIT;
  // Expired guest artifacts are left out here, not after the limit, so they never crowd out the ones that are still there
  const notExpired = { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  const inChat = await prisma.artifact.findMany({ where: { chatKind: input.chat.kind, chatRef: input.chat.ref, ...notExpired }, include, orderBy, take });
  const own = who.userId ? await prisma.artifact.findMany({ where: { ownerId: who.userId, ...notExpired }, include, orderBy, take }) : [];
  const seen = new Set(inChat.map((row) => row.id));
  const rows = [...inChat, ...own.filter((row) => !seen.has(row.id))];
  return { artifacts: rows.filter((row) => canOpen(row, who, now)).slice(0, LIST_IN_CHAT_LIMIT).map(viewOf), hidden };
}

async function findVersion(artifact: ArtifactRow, number?: number | null) {
  const wanted = number ?? artifact.latestVersion;
  const row = await prisma.artifactVersion.findUnique({ where: { artifactId_number: { artifactId: artifact.id, number: wanted } } });
  if (!row) throw new ArtifactError('version_not_found', 404, 'No such version.');
  return row;
}

// ---- The game: open, versions, share, restore, copy -------------------------------------------------------------

/** Who is looking, as the game names them, and whether they are in the artifact's chat right now (the game vouches). */
export interface Viewer {
  person: Person;
  inChat: boolean;
  /** The chat the game vouches for; `inChat` counts only when it is the chat the artifact was made in. */
  chat?: Chat;
}

/** In the artifact's own chat: the chat the game named is the one it was made in, and the person is in it. Otherwise no. */
function viewerIsInChat(artifact: { chatKind: string | null; chatRef: string | null }, viewer: Viewer): boolean {
  return viewer.inChat && viewer.chat !== undefined && inThisChat(artifact, viewer.chat);
}

/** The person looking at this artifact: their account, and whether they are in the chat it was made in. */
async function whoIsLooking(artifact: ArtifactRow, viewer: Viewer): Promise<Who> {
  return resolvePerson(viewer.person, viewerIsInChat(artifact, viewer));
}

export interface Opened {
  artifact: ArtifactView;
  /** The version the box opens on (the latest unless one was asked for). */
  version: VersionView;
  you: Rights;
}

export async function openArtifact(id: string, viewer: Viewer, version?: number | null, ctx: Context = defaultContext()): Promise<Opened> {
  const { files, now } = ctx;
  pruneSometimes(ctx);
  const artifact = await loadArtifact(id, now);
  const who = await whoIsLooking(artifact, viewer);
  requireOpen(artifact, who, now);
  const row = await findVersion(artifact, version);
  return { artifact: viewOf(artifact), version: versionView(row, files), you: rightsOf(artifact, who, now) };
}

export async function listVersions(id: string, viewer: Viewer, ctx: Context = defaultContext()): Promise<{ versions: VersionView[] }> {
  const { files, now } = ctx;
  const artifact = await loadArtifact(id, now);
  const who = await whoIsLooking(artifact, viewer);
  requireOpen(artifact, who, now);
  const rows = await prisma.artifactVersion.findMany({ where: { artifactId: artifact.id }, orderBy: { number: 'desc' } });
  return { versions: rows.map((row) => versionView(row, files)) };
}

/** The code of one version, for the Code view. */
export async function readVersionCode(id: string, number: number, viewer: Viewer, ctx: Context = defaultContext()): Promise<{ version: VersionView; content: string }> {
  const { files, now } = ctx;
  const artifact = await loadArtifact(id, now);
  const who = await whoIsLooking(artifact, viewer);
  requireOpen(artifact, who, now);
  const row = await findVersion(artifact, number);
  return { version: versionView(row, files), content: await files.get(row.fileKey) };
}

export interface SharingInput {
  openScope?: unknown;
  changeScope?: unknown;
}

export async function setSharing(id: string, viewer: Viewer, input: SharingInput, ctx: Context = defaultContext()): Promise<{ artifact: ArtifactView }> {
  const { now } = ctx;
  const artifact = await loadArtifact(id, now);
  const who = await whoIsLooking(artifact, viewer);
  requireOpen(artifact, who, now);
  requireOwner(artifact, who);
  const data: { openScope?: OpenScope; changeScope?: ChangeScope } = {};
  if (input.openScope !== undefined) {
    if (!isOneOf(OPEN_SCOPES, input.openScope)) throw new ArtifactError('invalid_open_scope', 422, 'Who can open it is chat or link.');
    data.openScope = input.openScope;
  }
  if (input.changeScope !== undefined) {
    if (!isOneOf(CHANGE_SCOPES, input.changeScope)) throw new ArtifactError('invalid_change_scope', 422, 'Who can ask for changes is owner or openers.');
    data.changeScope = input.changeScope;
  }
  if (Object.keys(data).length === 0) throw new ArtifactError('nothing_to_change', 422, 'Send who can open it, who can ask for changes, or both.');
  const updated = await prisma.artifact.update({ where: { id: artifact.id }, data, include: ARTIFACT_INCLUDE });
  return { artifact: viewOf(updated) };
}

/** Restore makes a new version out of an older one; nothing is deleted, so restoring can itself be undone. */
export async function restoreVersion(id: string, number: number, viewer: Viewer, ctx: Context = defaultContext()): Promise<Opened> {
  const { files, now } = ctx;
  const artifact = await loadArtifact(id, now);
  const who = await whoIsLooking(artifact, viewer);
  requireOpen(artifact, who, now);
  requireOwner(artifact, who);
  const { maxBytes, maxVersions } = await limitsOf(ctx);
  checkVersionRoom(artifact.latestVersion, maxVersions);
  const source = await findVersion(artifact, number);
  if (source.number === artifact.latestVersion) throw new ArtifactError('already_latest', 409, 'That is the latest version already.');
  const kind = artifact.kind as ArtifactKind;
  const content = await files.get(source.fileKey);
  // The size limit may have been lowered since this version was saved: a restore is a new version like any other
  checkContent(content, maxBytes);
  const next = artifact.latestVersion + 1;
  const fileKey = newFileKey(artifact.id, next, kind);
  const row = await storing(files, fileKey, kind, content, () =>
    prisma.$transaction(async (tx) => {
      const moved = await tx.artifact.updateMany({ where: { id: artifact.id, latestVersion: artifact.latestVersion }, data: { latestVersion: next } });
      if (moved.count !== 1) throw new ArtifactError('stale_version', 409, 'It changed at the same moment; try again.');
      return tx.artifactVersion.create({
        data: { artifactId: artifact.id, number: next, summary: `Restored version ${source.number}`, askedById: who.userId, askedByName: who.name, fileKey, sizeBytes: source.sizeBytes },
      });
    }),
  );
  const fresh = await loadArtifact(artifact.id, now);
  return { artifact: viewOf(fresh), version: versionView(row, files), you: rightsOf(fresh, who, now) };
}

/**
 * The owner takes it back: the rows go first (every version with them), then the files, with the same retry for files the
 * bucket would not remove as the guest clean-up. A copy someone made keeps its own files. The delete only goes through for the
 * version it read, so a change that lands meanwhile is not left with a file nobody lists: it asks again.
 */
export async function deleteArtifact(id: string, viewer: Viewer, ctx: Context = defaultContext()): Promise<{ deleted: true }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const artifact = await loadArtifact(id, ctx.now);
    const who = await whoIsLooking(artifact, viewer);
    requireOpen(artifact, who, ctx.now);
    requireOwner(artifact, who);
    const versions = await prisma.artifactVersion.findMany({ where: { artifactId: artifact.id } });
    const { count } = await prisma.artifact.deleteMany({ where: { id: artifact.id, latestVersion: artifact.latestVersion } });
    if (count === 1) {
      await removeFiles(ctx, versions.map((version) => version.fileKey));
      return { deleted: true };
    }
  }
  throw new ArtifactError('stale_version', 409, 'It changed at the same moment; try again.');
}

/** Make a copy: the viewer's own artifact, from the version they pick (the latest by default), in no chat. */
export async function copyArtifact(id: string, viewer: Viewer, version?: number | null, ctx: Context = defaultContext()): Promise<Opened> {
  const { files, now } = ctx;
  // Signing in comes first, so the answer for a guest does not tell whether the artifact is there
  if (!(await resolvePerson(viewer.person, false)).userId) throw new ArtifactError('sign_in_required', 403, 'Sign in to make a copy.');
  const source = await loadArtifact(id, now);
  const who = await whoIsLooking(source, viewer);
  requireOpen(source, who, now);
  const row = await findVersion(source, version);
  const kind = source.kind as ArtifactKind;
  const content = await files.get(row.fileKey);
  checkContent(content, (await limitsOf(ctx)).maxBytes);

  const copyId = randomUUID();
  const fileKey = newFileKey(copyId, 1, kind);
  const created = await storing(files, fileKey, kind, content, () =>
    prisma.artifact.create({
      data: {
        id: copyId,
        ownerId: who.userId,
        makerBotId: source.makerBotId,
        makerName: source.makerName,
        title: source.title,
        kind,
        copiedFromId: source.id,
        versions: {
          create: { number: 1, summary: `Copy of version ${row.number}`, askedById: who.userId, askedByName: who.name, fileKey, sizeBytes: row.sizeBytes },
        },
      },
      include: { ...ARTIFACT_INCLUDE, versions: true },
    }),
  );
  return { artifact: viewOf(created), version: versionView(created.versions[0], files), you: rightsOf(created, who, now) };
}

// ---- The public link page ---------------------------------------------------------------------------------------

/** What the page for "anyone with the link" shows: the latest version, nothing about who may do what. */
export interface PublicView {
  title: string;
  kind: ArtifactKind;
  makerName: string;
  version: number;
  /** Where the file is served from, for the locked box. */
  url: string;
  /** A document is drawn from its text (the page cannot show a Markdown file itself). */
  content: string | null;
}

/**
 * Opens an artifact for anyone who has its address, without an account: only when the owner shared it by link, and
 * only the latest version. One answer for every other case (not there, run out, shared only with its chat), so the page
 * tells nobody which of them it is.
 */
export async function openByLink(id: string, ctx: Context = defaultContext()): Promise<PublicView> {
  const { files, now } = ctx;
  pruneSometimes(ctx);
  const artifact = await loadArtifact(id, now);
  if (artifact.openScope !== 'link') throw new ArtifactError('not_found', 404, 'No such artifact.');
  const row = await findVersion(artifact, artifact.latestVersion);
  const kind = artifact.kind as ArtifactKind;
  return {
    title: artifact.title,
    kind,
    makerName: artifact.makerName,
    version: row.number,
    url: files.urlFor(row.fileKey),
    content: kind === 'markdown' ? await files.get(row.fileKey) : null,
  };
}

// ---- Housekeeping -----------------------------------------------------------------------------------------------

/** How many expired guest artifacts one batch clears, and how many batches one pass runs. */
const PRUNE_BATCH = 25;
const PRUNE_MAX_BATCHES = 8;
/** Reading an artifact also tidies up, but not more often than this. */
const PRUNE_EVERY_MS = 60_000;
/** How many files a pass keeps to try again, so a bucket that is down for long cannot fill the memory. */
const MAX_UNREMOVED_KEYS = 5000;
let lastPruneAt = 0;

/** For tests: forget when the last tidy-up ran. */
export function resetPruneClock(): void {
  lastPruneAt = 0;
  unremovedKeys = [];
}

/** Files whose rows are already gone but that the bucket would not remove; the next pass tries them again. */
let unremovedKeys: string[] = [];

async function removeFiles(ctx: Context, keys: string[]): Promise<void> {
  const all = [...unremovedKeys, ...keys];
  unremovedKeys = [];
  try {
    await ctx.files.remove(all);
  } catch (error) {
    // Another pass may have failed meanwhile and left its own files here: keep both
    unremovedKeys = [...new Set([...unremovedKeys, ...all])].slice(0, MAX_UNREMOVED_KEYS);
    console.error('Could not remove the files of expired artifacts, will try again:', error);
  }
}

/** Clears what guests asked for and the day is over for, with its files. Runs whenever something is made. */
export async function pruneExpired(ctx: Context = defaultContext()): Promise<number> {
  let cleared = 0;
  if (unremovedKeys.length > 0) await removeFiles(ctx, []);
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
    const expired = await prisma.artifact.findMany({
      where: { expiresAt: { lte: ctx.now } },
      take: PRUNE_BATCH,
      select: { id: true, versions: { select: { fileKey: true } } },
    });
    if (expired.length === 0) break;
    const ids = expired.map((artifact) => artifact.id);
    // The rows go first, and only while they are still expired: a guest who asked for a change a moment ago has pushed
    // the end further, and that artifact stays with all of its files
    const { count } = await prisma.artifact.deleteMany({ where: { id: { in: ids }, expiresAt: { lte: ctx.now } } });
    const kept = new Set(count === ids.length ? [] : (await prisma.artifact.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((row) => row.id));
    const keys = expired.filter((artifact) => !kept.has(artifact.id)).flatMap((artifact) => artifact.versions.map((version) => version.fileKey));
    await removeFiles(ctx, keys);
    cleared += count;
    if (expired.length < PRUNE_BATCH) break;
  }
  return cleared;
}

/** The same tidy-up from the read paths, so guest files go even when nobody makes anything new; once a minute at most. */
function pruneSometimes(ctx: Context): void {
  const at = ctx.now.getTime();
  if (at - lastPruneAt < PRUNE_EVERY_MS) return;
  lastPruneAt = at;
  void pruneExpired(ctx).catch((error) => console.error('Could not clear expired artifacts:', error));
}

/** The artifacts a signed-in person owns, the most recently changed first. A guest owns none. */
export async function listMine(person: Person): Promise<{ artifacts: ArtifactView[] }> {
  const who = await resolvePerson(person, false);
  if (!who.userId) return { artifacts: [] };
  const rows = await prisma.artifact.findMany({ where: { ownerId: who.userId }, include: ARTIFACT_INCLUDE, orderBy: { updatedAt: 'desc' }, take: 200 });
  return { artifacts: rows.map(viewOf) };
}
