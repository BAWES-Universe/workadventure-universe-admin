import type { PrismaClient } from '@prisma/client';
import { addQuestVersion, publishQuestVersion, type VersionSpec } from './definitions';
import { PLATFORM_SCOPE_ID } from './scope';

/**
 * The Welcome chapter as platform quests, with the keys the game already uses ("welcome.meet"), the actions its
 * detectors observe and the stamps it shows. Ensured once per process before the first player call, so a fresh
 * database offers the chapter without a seed.
 */
export const WELCOME_ACTIONS = {
  meet: 'hello-exchanged',
  explore: 'area-entered',
  build: 'entity-placed',
} as const;

export const WELCOME_CHAPTER_SPECS: ReadonlyArray<{ key: string; spec: VersionSpec }> = [
  {
    key: 'welcome.meet',
    spec: {
      purpose: 'Meet someone',
      order: 0,
      objectives: [{ key: 'hello', action: WELCOME_ACTIONS.meet, aggregation: 'STATE', evidence: 'CLIENT' }],
      rewards: [{ key: 'stamp', kind: 'BADGE', badgeId: 'first-hello', evidence: 'CLIENT' }],
    },
  },
  {
    key: 'welcome.explore',
    spec: {
      purpose: 'Explore this place',
      order: 1,
      objectives: [{ key: 'find', action: WELCOME_ACTIONS.explore, aggregation: 'STATE', evidence: 'CLIENT' }],
      rewards: [{ key: 'stamp', kind: 'BADGE', badgeId: 'explorer', evidence: 'CLIENT' }],
    },
  },
  {
    key: 'welcome.build',
    spec: {
      purpose: 'Try building',
      order: 2,
      objectives: [{ key: 'place', action: WELCOME_ACTIONS.build, aggregation: 'STATE', evidence: 'CLIENT' }],
      rewards: [{ key: 'stamp', kind: 'BADGE', badgeId: 'builder', evidence: 'CLIENT' }],
    },
  },
];

/** Creates and publishes any Welcome quest the platform scope lacks. Idempotent; a second caller finds them there. */
export async function ensureWelcomeChapter(prisma: PrismaClient): Promise<void> {
  for (const { key, spec } of WELCOME_CHAPTER_SPECS) {
    const definition =
      (await prisma.questDefinition.findUnique({ where: { scopeType_scopeId_key: { scopeType: 'PLATFORM', scopeId: PLATFORM_SCOPE_ID, key } } })) ??
      (await prisma.questDefinition
        .create({ data: { scopeType: 'PLATFORM', scopeId: PLATFORM_SCOPE_ID, key } })
        .catch(() => prisma.questDefinition.findUniqueOrThrow({ where: { scopeType_scopeId_key: { scopeType: 'PLATFORM', scopeId: PLATFORM_SCOPE_ID, key } } })));
    const published = await prisma.questVersion.findFirst({ where: { definitionId: definition.id, status: 'PUBLISHED' }, select: { id: true } });
    if (published) continue;
    const draft = await prisma.questVersion.findFirst({ where: { definitionId: definition.id, status: 'DRAFT' }, select: { id: true } });
    const version = draft ?? (await addQuestVersion(prisma, definition.id, spec));
    await publishQuestVersion(prisma, version.id, 'system');
  }
}

let ensured: Promise<void> | null = null;

/** Once per process; a failure lets the next call try again. */
export function ensureWelcomeChapterOnce(prisma: PrismaClient): Promise<void> {
  if (!ensured) {
    ensured = ensureWelcomeChapter(prisma).catch((error) => {
      ensured = null;
      throw error;
    });
  }
  return ensured;
}

/** For tests. */
export function resetWelcomeChapterOnce(): void {
  ensured = null;
}
