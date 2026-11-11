import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { checkBotAccess } from '@/lib/bot-access';
import { loadBotPrivacy } from '@/lib/bot-privacy';
import { findUserByIdentifier } from '@/lib/user-identifier';
import { artifactFiles, type ArtifactFiles } from '@/lib/artifact-storage';
import { getServerLimits } from '@/lib/bot-limits';
import { artifactBytes, artifactMediaBytes, type ArtifactLimits } from '@/lib/bot-limit-values';
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
  isJustYou,
  isOneOf,
  isOwner,
  mediaKeyFor,
  mediaOf,
  mergeMedia,
  newFileKey,
  type ArtifactEdit,
  type ArtifactKind,
  type Asker,
  type ChangeScope,
  type ChatKind,
  type MediaFile,
  type MediaUpload,
  type OpenScope,
} from '@/lib/artifacts';
import {
  MEDIA_POLICY,
  MEDIA_READ_HEADERS,
  drawingPolicy,
  hashOf,
  looksLikeSecret,
  mayShowPage,
  newSecret,
  orbitAddress,
  pagePolicy,
  parseRange,
  passAddress,
  passCookie,
  passFolderAddress,
  passCookieName,
  passLifeMs,
  readCookie,
  sameHash,
} from '@/lib/artifact-pass';

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

/** The size, version and media limits a super admin set (#666, #1510, #696). */
async function limitsOf(ctx: Context): Promise<{ maxBytes: number; maxVersions: number; maxMediaBytes: number; maxMediaFiles: number }> {
  const limits = ctx.limits ?? (await getServerLimits()).artifacts;
  return { maxBytes: artifactBytes(limits), maxVersions: limits.versions, maxMediaBytes: artifactMediaBytes(limits), maxMediaFiles: limits.mediaFiles };
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

/** A song, image or video a version carries (#1510): the page names it as is ("song.mp3"), it sits beside the page. */
export interface MediaView {
  name: string;
  contentType: string;
  sizeBytes: number;
}

export interface VersionView {
  number: number;
  summary: string | null;
  askedByName: string | null;
  sizeBytes: number;
  createdAt: string;
  media: MediaView[];
  /**
   * Where the file is served from, for the locked box. Null for a "Just you" artifact everywhere but in the answer to its
   * owner opening it: that one address is for that opening only (lib/artifact-pass.ts).
   */
  url: string | null;
}

type VersionRow = { number: number; summary: string | null; askedByName: string | null; sizeBytes: number; createdAt: Date; fileKey: string; media?: unknown };

/** What a bot is told about a version: the same, without the file's address (only the game opens the file). */
export type BotVersionView = Omit<VersionView, 'url'>;

function botVersionView(row: VersionRow): BotVersionView {
  return {
    number: row.number,
    summary: row.summary,
    askedByName: row.askedByName,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
    media: mediaOf(row).map(({ name, contentType, sizeBytes }) => ({ name, contentType, sizeBytes })),
  };
}

function versionView(row: VersionRow, url: string | null): VersionView {
  return { ...botVersionView(row), url };
}

/**
 * Where a version's file opens. The bucket's own address, which opens for anyone who has it, is only ever given for an
 * artifact that is not "Just you". A private one has an address only for a pass (one opening by its owner), and a
 * document needs none: it is drawn from its text, which the routes send to its owner alone.
 */
function addressOf(artifact: { openScope: string; kind: string }, row: VersionRow, files: ArtifactFiles, passToken?: string | null): string | null {
  if (!isJustYou(artifact)) return files.urlFor(row.fileKey);
  if (!passToken || artifact.kind === 'markdown') return null;
  return passAddress(passToken, row.number, artifact.kind as ArtifactKind);
}

/** One opening of a private artifact by its owner: the random part of the address its files are served at for it. */
async function issuePass(artifact: { id: string; kind: string }, userId: string, now: Date): Promise<string | null> {
  if (artifact.kind === 'markdown') return null;
  // Asked first: without Orbit's own address there is nowhere to serve it from, and no pass is left behind
  orbitAddress();
  const token = newSecret();
  await prisma.artifactPass.create({ data: { tokenHash: hashOf(token), artifactId: artifact.id, userId, expiresAt: new Date(now.getTime() + passLifeMs()) } });
  return token;
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
  /** In the chat it was made in right now, as the game vouches: the owner's Share menu offers "People in this chat". */
  inChat: boolean;
}

function rightsOf(artifact: ArtifactRow, who: Who, now: Date): Rights {
  const owner = isOwner(artifact, who);
  return {
    owner,
    change: canAskForChange(artifact, who, who.inChat, now),
    manage: owner,
    copy: who.userId !== null,
    // A copy is in no chat, whichever chat it was copied from
    inChat: who.inChat && artifact.chatRef !== null,
  };
}

/**
 * The answer for someone who may not open it. One answer for nearly every case (not there, run out, shared only with its
 * chat), so it tells nobody which. The one exception is a "Just you" artifact asked for from the chat it was made in: its
 * card is in front of that person already, so they are told its owner keeps it private (game #1994).
 */
function cannotOpen(artifact: ArtifactRow, inItsChat: boolean): ArtifactError {
  if (isJustYou(artifact) && inItsChat && artifact.chatRef !== null) return new ArtifactError('kept_private', 404, 'Its owner keeps this one private.');
  return new ArtifactError('not_found', 404, 'No such artifact.');
}

function requireOpen(artifact: ArtifactRow, who: Who, now: Date): void {
  if (!canOpen(artifact, who, now)) throw cannotOpen(artifact, who.inChat);
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

/** What read and change take on top of the call: the artifacts the person themselves pointed at (game #1781). */
interface ReferencingCall extends BotCall {
  /**
   * Ids of artifacts the person put in their own message (a pasted link) or replied to, as the bot server found them. The
   * only way for a bot to reach another bot's artifact, and only for its owner. Ids a bot or a tool result mentioned are
   * never sent.
   */
  referencedArtifactIds?: string[] | null;
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

/**
 * Is this artifact within a bot's reach by id? What was made in this chat, whoever the bot is. Beyond this chat only what the
 * person pointed at (a link in their message, a card they replied to), and the owner's artifacts this bot made. Anything else
 * looks like an artifact that is not there. The rules for a person (open, change) still apply on top: a pasted link opens
 * another person's artifact only when its owner shared it by link, and changing it stays with the chat it was made in.
 */
function inBotsReach(artifact: ArtifactRow, who: Asker, input: ReferencingCall): boolean {
  if (inThisChat(artifact, input.chat)) return true;
  if ((input.referencedArtifactIds ?? []).includes(artifact.id)) return true;
  return isOwner(artifact, who) && artifact.makerBotId === input.botId;
}

export interface MakeInput extends BotCall {
  title: string;
  kind: ArtifactKind;
  content: string;
  summary?: string | null;
  /** Songs, images and videos from the chat for the page to play or show (#1510). */
  media?: MediaUpload[];
}

export interface Made {
  artifact: ArtifactView;
  version: BotVersionView;
  hidden: boolean;
}

/** The media of a new version, in its own folder: what it keeps from an older version (copied) and what was sent (written). */
interface PlacedMedia {
  files: MediaFile[];
  copies: { from: string; to: string }[];
  uploads: { key: string; body: Uint8Array; contentType: string }[];
}

function placeMedia(fileKey: string, merged: { keep: MediaFile[]; add: MediaUpload[] }): PlacedMedia {
  const copies = merged.keep.map((file) => ({ from: file.key, to: mediaKeyFor(fileKey, file.name) }));
  const uploads = merged.add.map((upload) => ({ key: mediaKeyFor(fileKey, upload.name), body: upload.body, contentType: upload.contentType }));
  const files = [
    ...merged.keep.map((file) => ({ ...file, key: mediaKeyFor(fileKey, file.name) })),
    ...merged.add.map((upload) => ({ name: upload.name, contentType: upload.contentType, sizeBytes: upload.body.byteLength, key: mediaKeyFor(fileKey, upload.name) })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  return { files, copies, uploads };
}

/**
 * Stores the file and its media, then runs the database write; the files go again only if storing or that write fails.
 * Anything after the write (reading it back, clearing old artifacts) must stay outside, or an error there would delete
 * the files of a version that is already committed.
 */
async function storing<T>(files: ArtifactFiles, fileKey: string, kind: ArtifactKind, content: string, media: PlacedMedia, write: () => Promise<T>): Promise<T> {
  try {
    // Every write settles before anything is cleared: one that lands after the clean-up would stay in the bucket for good
    const stored = await Promise.allSettled([
      files.put(fileKey, content, fileTypeOf(kind).contentType),
      ...media.copies.map((copy) => files.copy(copy.from, copy.to)),
      ...media.uploads.map((upload) => files.put(upload.key, upload.body, upload.contentType)),
    ]);
    const failed = stored.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    return await write();
  } catch (error) {
    await files.remove([fileKey, ...media.files.map((file) => file.key)]).catch(() => undefined);
    throw error;
  }
}

/** Every file of these versions in the bucket: the page and the media beside it. */
const keysOf = (versions: { fileKey: string; media?: unknown }[]): string[] => versions.flatMap((version) => [version.fileKey, ...mediaOf(version).map((file) => file.key)]);

export async function makeArtifact(input: MakeInput, ctx: Context = defaultContext()): Promise<Made> {
  const { files, now } = ctx;
  const title = cleanLine(input.title, MAX_TITLE_LENGTH);
  if (!title) throw new ArtifactError('title_required', 422, 'An artifact needs a title.');
  if (!isOneOf(ARTIFACT_KINDS, input.kind)) throw new ArtifactError('invalid_kind', 422, 'Unknown kind of artifact.');
  const { maxBytes, maxMediaBytes, maxMediaFiles } = await limitsOf(ctx);
  checkContent(input.content, maxBytes);
  const merged = mergeMedia([], input.media ?? [], [], input.kind, maxMediaBytes, maxMediaFiles);
  const { botName, hidden } = await passBotGate(input);
  const who = await resolvePerson(input.person, true);

  const id = randomUUID();
  const fileKey = newFileKey(id, 1, input.kind);
  const media = placeMedia(fileKey, merged);
  const artifact = await storing(files, fileKey, input.kind, input.content, media, () =>
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
            media: media.files as unknown as Prisma.InputJsonValue,
          },
        },
      },
      include: { ...ARTIFACT_INCLUDE, versions: true },
    }),
  );
  await pruneExpired(ctx).catch((error) => console.error('Could not clear expired artifacts:', error));
  return { artifact: viewOf(artifact), version: botVersionView(artifact.versions[0]), hidden };
}

export interface ChangeInput extends ReferencingCall {
  artifactId: string;
  /** The version the bot read before it changed anything; a newer one in between stops the change. */
  baseVersion?: number | null;
  /** Small edits to the latest version, or the whole new file; at most one of them, and one unless the media change. */
  edits?: ArtifactEdit[] | null;
  content?: string | null;
  summary?: string | null;
  title?: string | null;
  /** New songs, images and videos (#1510); one with the name of a kept one takes its place. The rest are kept. */
  media?: MediaUpload[];
  /** Names of media the new version leaves out. */
  dropMedia?: string[] | null;
}

export async function changeArtifact(input: ChangeInput, ctx: Context = defaultContext()): Promise<Made> {
  const { files, now } = ctx;
  const hasEdits = Array.isArray(input.edits) && input.edits.length > 0;
  const hasContent = typeof input.content === 'string';
  const changesMedia = (input.media?.length ?? 0) > 0 || (input.dropMedia?.length ?? 0) > 0;
  if (hasEdits && hasContent) throw new ArtifactError('edits_or_content', 422, 'Send small edits or the whole new file, not both.');
  if (!hasEdits && !hasContent && !changesMedia) throw new ArtifactError('edits_or_content', 422, 'Send small edits, the whole new file, or media to add or drop.');
  const { botName, hidden } = await passBotGate(input);
  const who = await resolvePerson(input.person, true);
  const artifact = await loadArtifact(input.artifactId, now);
  if (!inBotsReach(artifact, who, input)) throw new ArtifactError('not_found', 404, 'No such artifact.');
  if (!canAskForChange(artifact, who, inThisChat(artifact, input.chat), now)) {
    // Someone who cannot even open it hears the same as for an artifact that is not there
    if (!canOpen(artifact, { ...who, inChat: inThisChat(artifact, input.chat) }, now)) throw cannotOpen(artifact, inThisChat(artifact, input.chat));
    throw new ArtifactError('change_not_allowed', 403, 'The owner has not allowed changes from this person.');
  }
  const { maxBytes, maxVersions, maxMediaBytes, maxMediaFiles } = await limitsOf(ctx);
  // Another bot's work is never written into: a bot that did not make it works on a copy of its own (game #1805, Orbit #800),
  // which starts at version 1, so the original's version limit does not apply to it
  const copying = artifact.makerBotId !== input.botId;
  if (!copying) checkVersionRoom(artifact.latestVersion, maxVersions);
  if (input.baseVersion != null && input.baseVersion !== artifact.latestVersion) {
    throw new ArtifactError('stale_version', 409, `It is on version ${artifact.latestVersion} now; read it again and send the change on that.`);
  }

  const kind = artifact.kind as ArtifactKind;
  const latest = await prisma.artifactVersion.findUnique({ where: { artifactId_number: { artifactId: artifact.id, number: artifact.latestVersion } } });
  if (!latest) throw new ArtifactError('file_missing', 502, 'The latest version could not be found.');
  const content = hasContent ? (input.content as string) : hasEdits ? applyEdits(await files.get(latest.fileKey), input.edits as ArtifactEdit[], maxBytes) : await files.get(latest.fileKey);
  checkContent(content, maxBytes);
  const merged = mergeMedia(mediaOf(latest), input.media ?? [], input.dropMedia ?? [], kind, maxMediaBytes, maxMediaFiles);
  const title = cleanLine(input.title, MAX_TITLE_LENGTH);
  if (copying) return changeInACopy({ input, artifact, latestNumber: latest.number, who, botName, hidden, content, merged, title }, ctx);

  const next = artifact.latestVersion + 1;
  const fileKey = newFileKey(artifact.id, next, kind);
  const media = placeMedia(fileKey, merged);
  const row = await storing(files, fileKey, kind, content, media, () =>
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
          media: media.files as unknown as Prisma.InputJsonValue,
        },
      });
    }),
  );
  const fresh = await loadArtifact(artifact.id, now);
  return { artifact: viewOf(fresh), version: botVersionView(row), hidden };
}

/**
 * A change by a bot that did not make the artifact (game #1805, Orbit #800): the original keeps its versions as they were, and
 * the change becomes version 1 of a new artifact this bot makes for the person who asked, in the chat it is in, with the
 * original's latest text and media plus the change. It starts private to that chat: how the original was shared is not carried
 * over, with one exception. A copy of a "Just you" artifact is "Just you" too (game #1994): only its owner could ask for it, and
 * asking for a change never shows it to anyone else. The bot's next change to it is an ordinary new version, since it is now the maker.
 */
async function changeInACopy(
  call: {
    input: ChangeInput;
    artifact: ArtifactRow;
    latestNumber: number;
    who: Who;
    botName: string;
    hidden: boolean;
    content: string;
    merged: { keep: MediaFile[]; add: MediaUpload[] };
    title: string | null;
  },
  ctx: Context,
): Promise<Made> {
  const { files, now } = ctx;
  const { input, artifact, who } = call;
  const kind = artifact.kind as ArtifactKind;
  const id = randomUUID();
  const fileKey = newFileKey(id, 1, kind);
  const media = placeMedia(fileKey, call.merged);
  const created = await storing(files, fileKey, kind, call.content, media, () =>
    prisma.artifact.create({
      data: {
        id,
        ownerId: who.userId,
        makerBotId: input.botId,
        makerName: clipText(call.botName, MAX_NAME_LENGTH),
        title: call.title ?? artifact.title,
        kind,
        chatKind: input.chat.kind,
        chatRef: input.chat.ref,
        copiedFromId: artifact.id,
        ...(isJustYou(artifact) ? { openScope: 'me' } : {}),
        // Nothing is kept for a guest beyond a day, and anyone in their chat may ask for a change meanwhile
        changeScope: who.userId ? 'owner' : 'openers',
        expiresAt: who.userId ? null : new Date(now.getTime() + GUEST_KEEP_MS),
        versions: {
          create: {
            number: 1,
            summary: cleanLine(input.summary, MAX_SUMMARY_LENGTH) ?? `Copy of version ${call.latestNumber}, changed`,
            askedById: who.userId,
            askedByName: who.name,
            fileKey,
            sizeBytes: byteLength(call.content),
            media: media.files as unknown as Prisma.InputJsonValue,
          },
        },
      },
      include: { ...ARTIFACT_INCLUDE, versions: true },
    }),
  );
  await pruneExpired(ctx).catch((error) => console.error('Could not clear expired artifacts:', error));
  return { artifact: viewOf(created), version: botVersionView(created.versions[0]), hidden: call.hidden };
}

export interface ReadInput extends ReferencingCall {
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
  if (!inBotsReach(artifact, who, input)) throw new ArtifactError('not_found', 404, 'No such artifact.');
  requireOpen(artifact, { ...who, inChat: inThisChat(artifact, input.chat) }, now);
  const row = await findVersion(artifact, input.version);
  return { artifact: viewOf(artifact), version: botVersionView(row), content: await files.get(row.fileKey), hidden };
}

/**
 * The artifacts made in this chat (by any bot in it) that the person may open, plus the ones this bot made for them in other
 * chats, the most recently changed first: how a bot finds the one "make the buttons bigger" is about, in a later message or
 * after a restart. An artifact belongs to the person who asked, so what a bot may do with it is what that person may; but a
 * bot is shown only its own work (and this chat's), never what the person made with other bots (game #1781).
 */
export async function listArtifactsInChat(input: BotCall, ctx: Context = defaultContext()): Promise<{ artifacts: ArtifactView[]; hidden: boolean }> {
  const { now } = ctx;
  const { hidden } = await passBotGate(input);
  const who = await resolvePerson(input.person, true);
  pruneSometimes(ctx);
  // What was made in this chat, and what this bot made for the asking person in any other chat, so a bot in a direct message
  // finds what they started in nearby chat and the other way round. Only theirs, and only this bot's: nobody else's artifact
  // is listed outside its chat, and another bot's work is not this bot's context.
  // This chat's come first, so a person with many artifacts elsewhere never pushes the chat's own out of the list.
  const include = ARTIFACT_INCLUDE;
  const orderBy = { updatedAt: 'desc' } as const;
  const take = LIST_IN_CHAT_LIMIT;
  // Expired guest artifacts and copies (which are in no chat) are left out here, not after the limit, so they never crowd out
  // the ones that are still there
  const notExpired = { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  const inChat = await prisma.artifact.findMany({ where: { chatKind: input.chat.kind, chatRef: input.chat.ref, ...notExpired }, include, orderBy, take });
  const own = who.userId ? await prisma.artifact.findMany({ where: { ownerId: who.userId, makerBotId: input.botId, chatRef: { not: null }, ...notExpired }, include, orderBy, take }) : [];
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
  // Only its owner gets this far with a private one: the address is theirs, for this opening
  const pass = isJustYou(artifact) && who.userId ? await issuePass(artifact, who.userId, now) : null;
  return { artifact: viewOf(artifact), version: versionView(row, addressOf(artifact, row, files, pass)), you: rightsOf(artifact, who, now) };
}

export async function listVersions(id: string, viewer: Viewer, ctx: Context = defaultContext()): Promise<{ versions: VersionView[] }> {
  const { files, now } = ctx;
  const artifact = await loadArtifact(id, now);
  const who = await whoIsLooking(artifact, viewer);
  requireOpen(artifact, who, now);
  const rows = await prisma.artifactVersion.findMany({ where: { artifactId: artifact.id }, orderBy: { number: 'desc' } });
  return { versions: rows.map((row) => versionView(row, addressOf(artifact, row, files))) };
}

/** The code of one version, for the Code view. */
export async function readVersionCode(id: string, number: number, viewer: Viewer, ctx: Context = defaultContext()): Promise<{ version: VersionView; content: string }> {
  const { files, now } = ctx;
  const artifact = await loadArtifact(id, now);
  const who = await whoIsLooking(artifact, viewer);
  requireOpen(artifact, who, now);
  const row = await findVersion(artifact, number);
  return { version: versionView(row, addressOf(artifact, row, files)), content: await files.get(row.fileKey) };
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
    if (!isOneOf(OPEN_SCOPES, input.openScope)) throw new ArtifactError('invalid_open_scope', 422, 'Who can open it is me, chat or link.');
    data.openScope = input.openScope;
  }
  if (input.changeScope !== undefined) {
    if (!isOneOf(CHANGE_SCOPES, input.changeScope)) throw new ArtifactError('invalid_change_scope', 422, 'Who can ask for changes is owner or openers.');
    data.changeScope = input.changeScope;
  }
  if (Object.keys(data).length === 0) throw new ArtifactError('nothing_to_change', 422, 'Send who can open it, who can ask for changes, or both.');
  // Becoming "Just you" is more than a word in a column: its files move first (see makeJustYou)
  if (data.openScope === 'me' && !isJustYou(artifact)) {
    await makeJustYou(artifact, data.changeScope, ctx);
    return { artifact: viewOf(await loadArtifact(artifact.id, now)) };
  }
  const updated = await prisma.artifact.update({ where: { id: artifact.id }, data, include: ARTIFACT_INCLUDE });
  return { artifact: viewOf(updated) };
}

/** How many files are copied at once while an artifact's files move. */
const MOVE_AT_ONCE = 6;

/**
 * Makes an artifact "Just you" (game #1994), so that the file itself is protected and not only its card.
 *
 * Until now its files were served from the bucket's own address, to everyone its owner let open it. Those addresses
 * open for anyone who kept one, so they have to stop working. Every version's page and media is copied to a new address
 * that nobody was given, the versions are pointed at the copies in the same step that sets "Just you", and the old files
 * are listed to be removed and removed straight away. From then on the files are only served by Orbit, to their owner
 * (lib/artifact-pass.ts).
 *
 * Nothing is half done: if a copy fails, or a new version lands meanwhile, the copies go and the artifact stays as it
 * was. If the bucket will not remove an old file, it stays listed and every tidy-up tries again until it is gone. A copy
 * that a browser or a network cache already holds cannot be taken back; nothing new is ever served from the old address.
 */
async function makeJustYou(artifact: ArtifactRow, changeScope: ChangeScope | undefined, ctx: Context): Promise<void> {
  const { files } = ctx;
  // Asked first: without Orbit's own address its owner could not be shown it afterwards
  orbitAddress();
  const kind = artifact.kind as ArtifactKind;
  const versions = await prisma.artifactVersion.findMany({ where: { artifactId: artifact.id } });
  const moves = versions.map((version) => {
    const fileKey = newFileKey(artifact.id, version.number, kind);
    const media = mediaOf(version).map((file) => ({ ...file, key: mediaKeyFor(fileKey, file.name) }));
    const copies = [{ from: version.fileKey, to: fileKey }, ...mediaOf(version).map((file) => ({ from: file.key, to: mediaKeyFor(fileKey, file.name) }))];
    return { id: version.id, fileKey, media, copies };
  });
  const copies = moves.flatMap((move) => move.copies);
  try {
    for (let start = 0; start < copies.length; start += MOVE_AT_ONCE) {
      // Every copy of a batch settles before anything is cleared: one that lands after the clean-up would stay for good
      const done = await Promise.allSettled(copies.slice(start, start + MOVE_AT_ONCE).map((copy) => files.copy(copy.from, copy.to)));
      const failed = done.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
    await prisma.$transaction(async (tx) => {
      // Only for the artifact as it was read: a version made meanwhile would be left at an address that was handed out
      const moved = await tx.artifact.updateMany({
        where: { id: artifact.id, latestVersion: artifact.latestVersion, openScope: artifact.openScope },
        data: { openScope: 'me', ...(changeScope ? { changeScope } : {}) },
      });
      if (moved.count !== 1) throw new ArtifactError('stale_version', 409, 'It changed at the same moment; try again.');
      for (const move of moves) {
        await tx.artifactVersion.update({ where: { id: move.id }, data: { fileKey: move.fileKey, media: move.media as unknown as Prisma.InputJsonValue } });
      }
      await tx.artifactRetiredFile.createMany({ data: copies.map((copy) => ({ key: copy.from })), skipDuplicates: true });
    });
  } catch (error) {
    await files.remove(copies.map((copy) => copy.to)).catch(() => undefined);
    throw error;
  }
  await retireFiles(ctx);
}

/** How many old files one pass removes at once, and how many batches it runs. */
const RETIRE_BATCH = 500;
const RETIRE_MAX_BATCHES = 8;

/**
 * Removes the files whose addresses were handed out before their artifact became "Just you". They are listed in the
 * database, not in memory, so a restart never forgets one: a file stays listed until the bucket has removed it.
 */
async function retireFiles(ctx: Context): Promise<void> {
  for (let batch = 0; batch < RETIRE_MAX_BATCHES; batch++) {
    const rows = await prisma.artifactRetiredFile.findMany({ orderBy: { createdAt: 'asc' }, take: RETIRE_BATCH });
    if (rows.length === 0) return;
    const keys = rows.map((row) => row.key);
    try {
      await ctx.files.remove(keys);
    } catch (error) {
      console.error('Could not remove the old files of a private artifact, will try again:', error instanceof Error ? error.message : 'unknown');
      return;
    }
    await prisma.artifactRetiredFile.deleteMany({ where: { key: { in: keys } } });
    if (rows.length < RETIRE_BATCH) return;
  }
}

/** Restore makes a new version out of an older one; nothing is deleted, so restoring can itself be undone. */
export async function restoreVersion(id: string, number: number, viewer: Viewer, ctx: Context = defaultContext()): Promise<Opened> {
  const { files, now } = ctx;
  const artifact = await loadArtifact(id, now);
  const who = await whoIsLooking(artifact, viewer);
  requireOpen(artifact, who, now);
  requireOwner(artifact, who);
  const { maxBytes, maxVersions, maxMediaBytes } = await limitsOf(ctx);
  checkVersionRoom(artifact.latestVersion, maxVersions);
  const source = await findVersion(artifact, number);
  if (source.number === artifact.latestVersion) throw new ArtifactError('already_latest', 409, 'That is the latest version already.');
  const kind = artifact.kind as ArtifactKind;
  const content = await files.get(source.fileKey);
  // The size limit may have been lowered since this version was saved: a restore is a new version like any other
  checkContent(content, maxBytes);
  const next = artifact.latestVersion + 1;
  const fileKey = newFileKey(artifact.id, next, kind);
  const media = placeMedia(fileKey, mergeMedia(mediaOf(source), [], [], kind, maxMediaBytes));
  const row = await storing(files, fileKey, kind, content, media, () =>
    prisma.$transaction(async (tx) => {
      const moved = await tx.artifact.updateMany({ where: { id: artifact.id, latestVersion: artifact.latestVersion }, data: { latestVersion: next } });
      if (moved.count !== 1) throw new ArtifactError('stale_version', 409, 'It changed at the same moment; try again.');
      return tx.artifactVersion.create({
        data: {
          artifactId: artifact.id,
          number: next,
          summary: `Restored version ${source.number}`,
          askedById: who.userId,
          askedByName: who.name,
          fileKey,
          sizeBytes: source.sizeBytes,
          media: media.files as unknown as Prisma.InputJsonValue,
        },
      });
    }),
  );
  const fresh = await loadArtifact(artifact.id, now);
  return { artifact: viewOf(fresh), version: versionView(row, addressOf(fresh, row, files)), you: rightsOf(fresh, who, now) };
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
      await removeFiles(ctx, keysOf(versions));
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
  const { maxBytes, maxMediaBytes } = await limitsOf(ctx);
  checkContent(content, maxBytes);

  const copyId = randomUUID();
  const fileKey = newFileKey(copyId, 1, kind);
  const media = placeMedia(fileKey, mergeMedia(mediaOf(row), [], [], kind, maxMediaBytes));
  const created = await storing(files, fileKey, kind, content, media, () =>
    prisma.artifact.create({
      data: {
        id: copyId,
        ownerId: who.userId,
        makerBotId: source.makerBotId,
        makerName: source.makerName,
        title: source.title,
        kind,
        copiedFromId: source.id,
        // A copy of a "Just you" artifact starts as "Just you": copying never shows it to anyone else
        ...(isJustYou(source) ? { openScope: 'me' } : {}),
        versions: {
          create: {
            number: 1,
            summary: `Copy of version ${row.number}`,
            askedById: who.userId,
            askedByName: who.name,
            fileKey,
            sizeBytes: row.sizeBytes,
            media: media.files as unknown as Prisma.InputJsonValue,
          },
        },
      },
      include: { ...ARTIFACT_INCLUDE, versions: true },
    }),
  );
  return { artifact: viewOf(created), version: versionView(created.versions[0], addressOf(created, created.versions[0], files)), you: rightsOf(created, who, now) };
}

// ---- The public link page ---------------------------------------------------------------------------------------

/** What the page for "anyone with the link" shows: the latest version, nothing about who may do what. */
export interface PublicView {
  title: string;
  kind: ArtifactKind;
  makerName: string;
  version: number;
  /** Where the file is served from, for the locked box. Null for a "Just you" document, which is drawn from `content`. */
  url: string | null;
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
  return latestView(artifact, files);
}

/**
 * Opens one of your own artifacts on You in Orbit, however it is shared (game #1474): its owner may open it from
 * anywhere, as in the game. Anyone else's, or one that is gone, gets the same answer as one that was never there.
 */
export async function openOwned(id: string, userId: string, ctx: Context = defaultContext()): Promise<PublicView> {
  const { files, now } = ctx;
  const artifact = await loadArtifact(id, now);
  if (artifact.ownerId !== userId) throw new ArtifactError('not_found', 404, 'No such artifact.');
  return latestView(artifact, files, isJustYou(artifact) ? await issuePass(artifact, userId, now) : null);
}

async function latestView(artifact: ArtifactRow, files: Context['files'], pass: string | null = null): Promise<PublicView> {
  const row = await findVersion(artifact, artifact.latestVersion);
  const kind = artifact.kind as ArtifactKind;
  return {
    title: artifact.title,
    kind,
    makerName: artifact.makerName,
    version: row.number,
    url: addressOf(artifact, row, files, pass),
    content: kind === 'markdown' ? await files.get(row.fileKey) : null,
  };
}

// ---- A private artifact's files (game #1994) --------------------------------------------------------------------

/** One request for a file of a private artifact, as it came to /af/<pass>/<version>/<name>. */
export interface PrivateFileRequest {
  token: string;
  number: string;
  name: string;
  /** The Cookie header, as sent. */
  cookies: string | null;
  /** Sec-Fetch-Dest: what the browser wants it for. */
  fetchDest: string | null;
  /** Range: the part of a song or video a player asks for. */
  range: string | null;
}

export interface PrivateFile {
  status: 200 | 206 | 416;
  headers: Record<string, string>;
  body: string | Uint8Array | ReadableStream<Uint8Array> | null;
}

/** What every private file is sent with: kept by nobody but the browser that asked, never listed, never guessed at. */
const PRIVATE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' } as const;

/**
 * Serves one file of a "Just you" artifact for a pass (lib/artifact-pass.ts tells the whole of it). Checked on every
 * request, nothing remembered between two: the pass is known and has time left, its artifact is still there, and the
 * person the pass was made for still owns it. So a pass stops the moment its artifact is deleted, with no delay.
 *
 * The page or drawing: the first request is answered with a cookie only this pass's addresses read; every later one
 * needs it. The media beside a page: served once the page has been. One answer for everything else, so an address tells
 * nothing about what is behind it.
 */
export async function servePrivateFile(request: PrivateFileRequest, ctx: Context = defaultContext()): Promise<PrivateFile> {
  const { files, now } = ctx;
  const gone = () => new ArtifactError('not_found', 404, 'Not found.');
  const number = Number(request.number);
  if (!looksLikeSecret(request.token) || !Number.isInteger(number) || number < 1 || number > 2147483647) throw gone();
  const tokenHash = hashOf(request.token);
  const pass = await prisma.artifactPass.findUnique({ where: { tokenHash } });
  if (!pass || pass.expiresAt.getTime() <= now.getTime()) throw gone();
  const artifact = await prisma.artifact.findUnique({ where: { id: pass.artifactId } });
  if (!artifact || hasExpired(artifact, now) || artifact.ownerId === null || artifact.ownerId !== pass.userId) throw gone();
  const row = await prisma.artifactVersion.findUnique({ where: { artifactId_number: { artifactId: artifact.id, number } } });
  if (!row) throw gone();
  const kind = artifact.kind as ArtifactKind;

  if (request.name === `index.${fileTypeOf(kind).extension}`) {
    // A document is drawn from its text, which the routes send to its owner: it has no address at all
    if (kind === 'markdown') throw gone();
    if (kind !== 'svg' && !mayShowPage(request.fetchDest)) throw new ArtifactError('frame_only', 403, 'This page opens only inside Universe.');
    const headers: Record<string, string> = {
      ...PRIVATE_HEADERS,
      'Cache-Control': 'private, no-store',
      'Content-Type': fileTypeOf(kind).contentType,
      'Content-Security-Policy': kind === 'svg' ? drawingPolicy() : pagePolicy(passFolderAddress(request.token, number)),
    };
    if (pass.redeemedAt === null) {
      const cookie = newSecret();
      // Only one request can be the first: the pass is tied to the browser that made it
      const first = await prisma.artifactPass.updateMany({ where: { id: pass.id, redeemedAt: null }, data: { redeemedAt: now, cookieHash: hashOf(cookie) } });
      if (first.count !== 1) throw new ArtifactError('opened_elsewhere', 403, 'This private page opens only where its owner opened it.');
      headers['Set-Cookie'] = passCookie(request.token, tokenHash, cookie, (pass.expiresAt.getTime() - now.getTime()) / 1000);
    } else {
      const cookie = readCookie(request.cookies, passCookieName(tokenHash));
      if (!cookie || !pass.cookieHash || !sameHash(hashOf(cookie), pass.cookieHash)) {
        throw new ArtifactError('opened_elsewhere', 403, 'This private page opens only where its owner opened it.');
      }
    }
    return { status: 200, headers, body: await files.get(row.fileKey) };
  }

  const media = mediaOf(row).find((file) => file.name === request.name);
  // Nothing beside a page is served before the page itself has been
  if (!media || pass.redeemedAt === null) throw gone();
  const headers: Record<string, string> = {
    ...PRIVATE_HEADERS,
    'Cache-Control': 'private, max-age=3600',
    'Content-Type': media.contentType,
    'Content-Security-Policy': MEDIA_POLICY,
    'Accept-Ranges': 'bytes',
    ...MEDIA_READ_HEADERS,
  };
  const range = parseRange(request.range, media.sizeBytes);
  if (range === 'unsatisfiable') return { status: 416, headers: { ...headers, 'Content-Range': `bytes */${media.sizeBytes}` }, body: null };
  const body = await files.read(media.key, range ?? undefined);
  if (range) {
    return { status: 206, headers: { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${media.sizeBytes}`, 'Content-Length': String(range.end - range.start + 1) }, body };
  }
  return { status: 200, headers: { ...headers, 'Content-Length': String(media.sizeBytes) }, body };
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
  // "Just you" (game #1994): old files the bucket would not remove before, and passes that ran out
  await retireFiles(ctx);
  await prisma.artifactPass.deleteMany({ where: { expiresAt: { lte: ctx.now } } });
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
    const expired = await prisma.artifact.findMany({
      where: { expiresAt: { lte: ctx.now } },
      take: PRUNE_BATCH,
      select: { id: true, versions: { select: { fileKey: true, media: true } } },
    });
    if (expired.length === 0) break;
    const ids = expired.map((artifact) => artifact.id);
    // The rows go first, and only while they are still expired: a guest who asked for a change a moment ago has pushed
    // the end further, and that artifact stays with all of its files
    const { count } = await prisma.artifact.deleteMany({ where: { id: { in: ids }, expiresAt: { lte: ctx.now } } });
    const kept = new Set(count === ids.length ? [] : (await prisma.artifact.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((row) => row.id));
    const keys = expired.filter((artifact) => !kept.has(artifact.id)).flatMap((artifact) => keysOf(artifact.versions));
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

// ---- Lists for people (#1474): a chat's artifacts in the game, and all yours on You in Orbit ----------------------

/** How many artifacts a list hands over at once; the next ones come as the person scrolls. */
export const ARTIFACT_PAGE_SIZE = 50;

/** One page of a list: `total` is how many there are in all, `next` where the next page starts (null at the end). */
export interface ArtifactPage<View = ArtifactView> {
  artifacts: View[];
  total: number;
  next: number | null;
}

/** A row of a chat's list: also whether it is the asking person's own, so the game names the owner only when it isn't. */
export type ChatArtifactView = ArtifactView & { yours: boolean };

/** The most recently changed first; the id keeps the order fixed between pages when two changed at the same moment. */
const PAGE_ORDER = [{ updatedAt: 'desc' }, { id: 'desc' }] as const;

async function pageOf<View = ArtifactView>(
  where: Prisma.ArtifactWhereInput,
  offset: number,
  view: (artifact: ArtifactRow) => View = viewOf as (artifact: ArtifactRow) => View,
): Promise<ArtifactPage<View>> {
  const [total, rows] = await Promise.all([
    prisma.artifact.count({ where }),
    prisma.artifact.findMany({ where, include: ARTIFACT_INCLUDE, orderBy: [...PAGE_ORDER], skip: offset, take: ARTIFACT_PAGE_SIZE }),
  ]);
  const end = offset + rows.length;
  return { artifacts: rows.map(view), total, next: end < total && rows.length > 0 ? end : null };
}

const notExpiredAt = (now: Date): Prisma.ArtifactWhereInput => ({ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });

/**
 * The artifacts made in one chat that this person may open, for the chat's profile or details in the game: the same
 * rule as opening one. Someone the game vouches is in a nearby chat sees what was made in it, as its cards open for
 * them; anyone else sees only their own and those shared by link. Nothing they could not open is ever listed.
 */
export async function listChatArtifacts(viewer: Viewer, offset = 0, ctx: Context = defaultContext()): Promise<ArtifactPage<ChatArtifactView>> {
  const { now } = ctx;
  const chat = viewer.chat;
  if (!chat) return { artifacts: [], total: 0, next: null };
  pruneSometimes(ctx);
  // Every artifact here was made in this chat, so the game's word counts for all of them (see viewerIsInChat)
  const who = await resolvePerson(viewer.person, viewer.inChat);
  const own: Prisma.ArtifactWhereInput[] = who.userId ? [{ ownerId: who.userId }] : [];
  // In the chat: everything made in it, but someone else's "Just you" is not theirs to open (game #1994). Outside it: only
  // their own and those shared by link.
  const opens: Prisma.ArtifactWhereInput = who.inChat ? { OR: [...own, { openScope: { in: ['chat', 'link'] } }] } : { OR: [...own, { openScope: 'link' }] };
  return pageOf({ chatKind: chat.kind, chatRef: chat.ref, AND: [notExpiredAt(now), opens] }, offset, (artifact) => ({
    ...viewOf(artifact),
    yours: who.userId !== null && artifact.ownerId === who.userId,
  }));
}

/** Every artifact this account owns, from every chat and bot, copies too, a page at a time (Your artifacts in Orbit). */
export async function listOwned(userId: string, offset = 0): Promise<ArtifactPage> {
  return pageOf({ ownerId: userId }, offset);
}

/** The same list for the game's window (game #1609), named by the game's server. A guest owns none. */
export async function listOwnedBy(person: Person, offset = 0): Promise<ArtifactPage> {
  const who = await resolvePerson(person, false);
  if (!who.userId) return { artifacts: [], total: 0, next: null };
  return listOwned(who.userId, offset);
}
