import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { artifactFiles, type ArtifactFiles } from '@/lib/artifact-storage';
import { ARTIFACT_KINDS, MAX_NAME_LENGTH, MAX_SUMMARY_LENGTH, MAX_TITLE_LENGTH, cleanLine, clipText, fileTypeOf, newFileKey, type ArtifactKind } from '@/lib/artifacts';
import { getServerLimits } from '@/lib/bot-limits';
import { artifactBytes } from '@/lib/bot-limit-values';
import { getOutputStore, outputKeyFor, type OutputStore } from '@/lib/workbench/store';
import { sha256Hex } from '@/lib/workbench/values';

/**
 * Results a person owns (register A43): files that a code job, and later a computer job, made. One place, so both keep them the same way.
 *
 *  - Owned by the person, with where they came from (the job and the Brick that made them). They stay until the owner deletes them, inside the
 *    Limit for what one person may keep. The job's record expiring, the Brick being deleted, the computer being archived and the provider's copy
 *    expiring do not remove them; a Brick that is gone only changes the name shown on them to "A deleted Brick".
 *  - Encrypted at rest in Universe's own storage and opened only by their owner, as a download that can never run as part of Orbit.
 *  - Never public as they are. Publishing is a separate step of the owner's: an Artifact made from the result (`promoteResult`), which then
 *    follows the existing sharing rules of artifacts.
 */

export const SOURCE_KINDS = ['code_job', 'computer_job'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const DELETED_BRICK = 'A deleted Brick';

export interface KeepInput {
  ownerId: string;
  sourceKind: SourceKind;
  sourceId: string;
  makerBotId: string;
  makerName: string;
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface ResultView {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  sourceKind: SourceKind;
  sourceId: string;
  /** The Brick that made it, or "A deleted Brick" once that Brick is gone. */
  madeBy: string;
  madeAt: string;
  sha256: string;
  /** The Artifact the owner made from it, when they did. */
  artifactId: string | null;
  /** Always the owner alone. */
  access: 'owner';
  path: string;
}

type Row = Prisma.OwnedResultGetPayload<object>;

const view = (row: Row, madeBy: string): ResultView => ({
  id: row.id,
  name: row.name,
  contentType: row.contentType,
  sizeBytes: row.sizeBytes,
  sourceKind: row.sourceKind as SourceKind,
  sourceId: row.sourceId,
  madeBy,
  madeAt: row.createdAt.toISOString(),
  sha256: row.sha256,
  artifactId: row.artifactId,
  access: 'owner',
  path: `/api/workbench/outputs/${row.id}`,
});

/** What one person keeps now, in bytes. */
export async function keptBytes(ownerId: string): Promise<number> {
  const sum = await prisma.ownedResult.aggregate({ where: { ownerId }, _sum: { sizeBytes: true } });
  return sum._sum.sizeBytes ?? 0;
}

/** Keeps one file for its owner. The file goes into storage first and the row after; a row that cannot be written takes its file away again. */
export async function keepResult(input: KeepInput, store: OutputStore = getOutputStore()): Promise<Row> {
  const id = randomUUID();
  const storageKey = outputKeyFor(`${input.sourceKind}-${input.sourceId}`, id);
  await store.put(storageKey, input.bytes);
  try {
    return await prisma.ownedResult.create({
      data: {
        id,
        ownerId: input.ownerId,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        makerBotId: input.makerBotId,
        makerName: clipText(input.makerName, MAX_NAME_LENGTH),
        name: input.name,
        contentType: input.contentType,
        sizeBytes: input.bytes.byteLength,
        sha256: sha256Hex(input.bytes),
        storageKey,
      },
    });
  } catch (error) {
    await store.remove([storageKey]).catch(() => undefined);
    throw error;
  }
}

/** Names of Bricks that are gone, so "who made it" never keeps a deleted Brick's name. */
async function madeByNames(rows: Row[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((row) => row.makerBotId))];
  const bots = ids.length > 0 ? await prisma.bot.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, deletedAt: true } }) : [];
  const live = new Map(bots.filter((bot) => bot.deletedAt === null).map((bot) => [bot.id, bot.name]));
  return new Map(rows.map((row) => [row.id, live.get(row.makerBotId) ?? DELETED_BRICK]));
}

/** The owner's results, newest first, a page at a time. Nobody else's. */
export async function listResults(ownerId: string, options: { limit?: number; before?: string | null } = {}): Promise<{ results: ResultView[]; next: string | null; keptBytes: number }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const before = options.before ? new Date(options.before) : null;
  const rows = await prisma.ownedResult.findMany({
    where: { ownerId, ...(before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const names = await madeByNames(page);
  return {
    results: page.map((row) => view(row, names.get(row.id) ?? DELETED_BRICK)),
    next: rows.length > limit ? page[page.length - 1].createdAt.toISOString() : null,
    keptBytes: await keptBytes(ownerId),
  };
}

/** The results one job made, for the owner. */
export async function resultsOfSource(sourceKind: SourceKind, sourceId: string): Promise<Row[]> {
  return prisma.ownedResult.findMany({ where: { sourceKind, sourceId }, orderBy: { name: 'asc' } });
}

/** One kept file for its owner: the bytes, the name and the type it is served as. Null for anyone else, and for a file that has gone. */
export async function openResult(id: string, ownerId: string, store: OutputStore = getOutputStore()): Promise<{ name: string; contentType: string; bytes: Uint8Array } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const row = await prisma.ownedResult.findUnique({ where: { id } });
  if (!row || row.ownerId !== ownerId) return null;
  try {
    return { name: row.name, contentType: row.contentType, bytes: await store.get(row.storageKey) };
  } catch (error) {
    console.error('[Results] A kept file could not be opened:', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

/** The owner deleting one result: the stored file goes first, and the row only after, so a file that could not be removed is still listed and tried again. */
export async function deleteResult(id: string, ownerId: string, store: OutputStore = getOutputStore()): Promise<'deleted' | 'not_found'> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return 'not_found';
  const row = await prisma.ownedResult.findUnique({ where: { id } });
  if (!row || row.ownerId !== ownerId) return 'not_found';
  await store.remove([row.storageKey]);
  await prisma.ownedResult.deleteMany({ where: { id } });
  return 'deleted';
}

/** Every result of one job: when the job did not end normally (cancelled, out of time, lost) and its files were not meant to be kept. */
export async function removeResultsOf(sourceKind: SourceKind, sourceId: string, store: OutputStore = getOutputStore()): Promise<void> {
  const rows = await prisma.ownedResult.findMany({ where: { sourceKind, sourceId }, select: { storageKey: true } });
  await store.remove(rows.map((row) => row.storageKey));
  await prisma.ownedResult.deleteMany({ where: { sourceKind, sourceId } });
}

/** Results whose owner no longer exists (the account was deleted): removed from storage and the books, a batch at a time. */
export async function purgeOrphanedResults(store: OutputStore = getOutputStore(), batch = 50): Promise<number> {
  const rows = await prisma.$queryRaw<{ id: string; storage_key: string }[]>`
    SELECT r."id", r."storage_key" FROM "owned_results" r
    WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = r."owner_id")
    LIMIT ${batch}`;
  if (rows.length === 0) return 0;
  await store.remove(rows.map((row) => row.storage_key));
  await prisma.ownedResult.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  return rows.length;
}

// ---------- Publishing: a separate, authorized step ----------

/** The Artifact kind a file can become: a page, a Markdown document or an SVG drawing. Anything else stays a file. */
export function artifactKindOf(name: string, contentType: string): ArtifactKind | null {
  const type = contentType.split(';')[0].trim().toLowerCase();
  const lower = name.toLowerCase();
  let kind: ArtifactKind | null = null;
  if (type === 'text/markdown' || lower.endsWith('.md')) kind = 'markdown';
  else if (type === 'image/svg+xml' || lower.endsWith('.svg')) kind = 'svg';
  else if (type === 'text/html' || lower.endsWith('.html') || lower.endsWith('.htm')) kind = 'page';
  return kind && ARTIFACT_KINDS.includes(kind) ? kind : null;
}

export type Promoted = { status: 'made'; artifactId: string; kind: ArtifactKind } | { status: 'already'; artifactId: string } | { status: 'refused'; reason: 'not_found' | 'not_an_artifact_type' | 'too_big' | 'not_text' };

/**
 * The owner making an Artifact of one of their results. The Artifact starts "Just you" (nobody else can open it): who else may is the owner's
 * next, separate choice, with the same sharing rules every artifact has. Made once: asking again says which one it is. The result file stays.
 */
export async function promoteResult(id: string, ownerId: string, input: { title?: string | null } = {}, deps: { store?: OutputStore; files?: ArtifactFiles } = {}): Promise<Promoted> {
  const store = deps.store ?? getOutputStore();
  const files = deps.files ?? artifactFiles;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { status: 'refused', reason: 'not_found' };
  const row = await prisma.ownedResult.findUnique({ where: { id } });
  if (!row || row.ownerId !== ownerId) return { status: 'refused', reason: 'not_found' };
  if (row.artifactId) return { status: 'already', artifactId: row.artifactId };
  const kind = artifactKindOf(row.name, row.contentType);
  if (!kind) return { status: 'refused', reason: 'not_an_artifact_type' };
  // The same size an artifact may be, as the super admin set it
  if (row.sizeBytes > artifactBytes((await getServerLimits()).artifacts)) return { status: 'refused', reason: 'too_big' };
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(await store.get(row.storageKey));
  } catch {
    return { status: 'refused', reason: 'not_text' };
  }
  const maker = await madeByNames([row]);
  const artifactId = randomUUID();
  const fileKey = newFileKey(artifactId, 1, kind);
  await files.put(fileKey, content, fileTypeOf(kind).contentType);
  try {
    await prisma.$transaction(async (tx) => {
      // One artifact for one result: the claim is made first, so two asks at once make one
      const claimed = await tx.ownedResult.updateMany({ where: { id, artifactId: null }, data: { artifactId } });
      if (claimed.count !== 1) throw new AlreadyMade();
      await tx.artifact.create({
        data: {
          id: artifactId,
          ownerId,
          makerBotId: row.makerBotId,
          makerName: clipText(maker.get(row.id) === DELETED_BRICK ? DELETED_BRICK : row.makerName, MAX_NAME_LENGTH),
          title: cleanLine(input.title, MAX_TITLE_LENGTH) ?? cleanLine(row.name.replace(/\.[^.]+$/, ''), MAX_TITLE_LENGTH) ?? 'Result',
          kind,
          openScope: 'me',
          changeScope: 'owner',
          versions: { create: { number: 1, summary: clipText(`Made from a result of ${row.sourceKind === 'code_job' ? 'a code job' : 'a computer job'}`, MAX_SUMMARY_LENGTH), askedById: ownerId, fileKey, sizeBytes: row.sizeBytes } },
        },
      });
    });
  } catch (error) {
    await files.remove([fileKey]).catch(() => undefined);
    if (error instanceof AlreadyMade) {
      const again = await prisma.ownedResult.findUnique({ where: { id }, select: { artifactId: true } });
      if (again?.artifactId) return { status: 'already', artifactId: again.artifactId };
    }
    throw error;
  }
  return { status: 'made', artifactId, kind };
}

class AlreadyMade extends Error {}
