/**
 * The owner's Welcome chapter in the proof slice: the form's draft, the published record, and the link that shows it
 * in the game. There is no quest engine or table yet, so a published quest is a record in this browser only
 * (localStorage, per room), read back as untrusted input.
 */

export const QUEST_PATHS = ['meet', 'explore', 'build'] as const;
export type QuestPath = (typeof QUEST_PATHS)[number];

/** Rough minutes on each option row, as the game's QUEST_MINUTES (play/src/front/Quests/QuestModel.ts). */
export const QUEST_MINUTES: Record<QuestPath, number> = { meet: 2, explore: 1, build: 2 };

/** The game's stamp ids (QUEST_STAMPS), which the bridge's quest state carries. */
export const QUEST_STAMP_PATH = { 'first-hello': 'meet', explorer: 'explore', builder: 'build' } as const;
export type QuestStampId = keyof typeof QUEST_STAMP_PATH;

export type QuestHostKind = 'none' | 'bot' | 'area';

export interface QuestContextArea {
  id: string;
  name: string;
}
export interface QuestContextBot {
  id: string;
  name: string;
}
export interface QuestContext {
  areas: QuestContextArea[];
  bots: QuestContextBot[];
  source: 'wam' | 'none';
}

export const QUEST_DRAFT_VERSION = 1;

export interface QuestDraft {
  v: number;
  preset: 'welcome';
  meet: boolean;
  explore: boolean;
  build: boolean;
  areaId: string;
  hostKind: QuestHostKind;
  /** The bot's id or the area's id, for a bot or area host. */
  hostId: string;
}

export const EMPTY_QUEST_DRAFT: QuestDraft = {
  v: QUEST_DRAFT_VERSION,
  preset: 'welcome',
  meet: true,
  explore: true,
  build: false,
  areaId: '',
  hostKind: 'none',
  hostId: '',
};

const HOST_KINDS: readonly QuestHostKind[] = ['none', 'bot', 'area'];
const MAX_ID = 128;
const MAX_NAME = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

/** A saved draft in the current shape, or null for anything else. */
export function upgradeQuestDraft(raw: unknown): QuestDraft | null {
  if (!isRecord(raw)) return null;
  const draft: QuestDraft = { ...EMPTY_QUEST_DRAFT };
  for (const path of QUEST_PATHS) if (typeof raw[path] === 'boolean') draft[path] = raw[path] as boolean;
  if (boundedString(raw.areaId, MAX_ID)) draft.areaId = raw.areaId;
  if (HOST_KINDS.includes(raw.hostKind as QuestHostKind)) draft.hostKind = raw.hostKind as QuestHostKind;
  if (boundedString(raw.hostId, MAX_ID)) draft.hostId = raw.hostId;
  return draft;
}

export type QuestHost = { kind: 'none' } | { kind: 'bot'; id: string; name: string } | { kind: 'area'; id: string; name: string };

export interface PublishedQuest {
  v: 1;
  status: 'live' | 'paused';
  paths: Record<QuestPath, boolean>;
  area: QuestContextArea | null;
  host: QuestHost;
  publishedAt: string;
}

/** What stops the form from publishing, each said beside the field it belongs to. Empty when it can publish. */
export function draftProblems(draft: QuestDraft, context: QuestContext): { area?: string; host?: string; paths?: string } {
  const problems: { area?: string; host?: string; paths?: string } = {};
  if (!QUEST_PATHS.some((path) => draft[path])) problems.paths = 'Choose at least one thing to do.';
  if (draft.explore && !context.areas.some((area) => area.id === draft.areaId)) {
    problems.area = 'Pick an area or skip this path.';
  }
  if (draft.hostKind === 'bot' && !context.bots.some((bot) => bot.id === draft.hostId)) problems.host = 'Pick a bot, or choose No host.';
  if (draft.hostKind === 'area' && !context.areas.some((area) => area.id === draft.hostId)) {
    problems.host = 'Pick an area, or choose No host.';
  }
  return problems;
}

export function hostOf(draft: QuestDraft, context: QuestContext): QuestHost {
  if (draft.hostKind === 'bot') {
    const bot = context.bots.find((candidate) => candidate.id === draft.hostId);
    if (bot) return { kind: 'bot', id: bot.id, name: bot.name };
  }
  if (draft.hostKind === 'area') {
    const area = context.areas.find((candidate) => candidate.id === draft.hostId);
    if (area) return { kind: 'area', id: area.id, name: area.name };
  }
  return { kind: 'none' };
}

export function publishedFromDraft(draft: QuestDraft, context: QuestContext, status: PublishedQuest['status'], now = new Date()): PublishedQuest {
  const area = draft.explore ? context.areas.find((candidate) => candidate.id === draft.areaId) ?? null : null;
  return {
    v: 1,
    status,
    paths: { meet: draft.meet, explore: draft.explore && area !== null, build: draft.build },
    area,
    host: hostOf(draft, context),
    publishedAt: now.toISOString(),
  };
}

export function draftFromPublished(quest: PublishedQuest): QuestDraft {
  return {
    ...EMPTY_QUEST_DRAFT,
    meet: quest.paths.meet,
    explore: quest.paths.explore,
    build: quest.paths.build,
    areaId: quest.area?.id ?? '',
    hostKind: quest.host.kind,
    hostId: quest.host.kind === 'none' ? '' : quest.host.id,
  };
}

function parseNamed(value: unknown): QuestContextArea | null {
  if (!isRecord(value) || !boundedString(value.id, MAX_ID) || !boundedString(value.name, MAX_NAME)) return null;
  if (!value.id || !value.name.trim()) return null;
  return { id: value.id, name: value.name };
}

function parseHost(value: unknown): QuestHost | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'none') return { kind: 'none' };
  if (value.kind !== 'bot' && value.kind !== 'area') return null;
  const named = parseNamed(value);
  return named ? { kind: value.kind, ...named } : null;
}

const MAX_RECORD_LENGTH = 4000;

/** A stored record, or null for anything that isn't one (another version, edited by hand, truncated). */
export function parsePublishedQuest(raw: string | null): PublishedQuest | null {
  if (!raw || raw.length > MAX_RECORD_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== 1) return null;
  if (value.status !== 'live' && value.status !== 'paused') return null;
  if (!isRecord(value.paths) || !QUEST_PATHS.every((path) => typeof (value.paths as Record<string, unknown>)[path] === 'boolean')) return null;
  const area = value.area === null ? null : parseNamed(value.area);
  if (value.area !== null && area === null) return null;
  const host = parseHost(value.host);
  if (!host) return null;
  if (!boundedString(value.publishedAt, 40) || Number.isNaN(Date.parse(value.publishedAt))) return null;
  const paths = value.paths as Record<QuestPath, boolean>;
  return {
    v: 1,
    status: value.status,
    paths: { meet: paths.meet, explore: paths.explore && area !== null, build: paths.build },
    area,
    host,
    publishedAt: value.publishedAt,
  };
}

const RECORD_PREFIX = 'orbit.quests.welcome:';

function localStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readPublishedQuest(roomId: string): PublishedQuest | null {
  try {
    return parsePublishedQuest(localStore()?.getItem(RECORD_PREFIX + roomId) ?? null);
  } catch {
    return null;
  }
}

/** Returns false when this browser won't keep it (storage blocked or full). */
export function writePublishedQuest(roomId: string, quest: PublishedQuest): boolean {
  const store = localStore();
  if (!store) return false;
  try {
    store.setItem(RECORD_PREFIX + roomId, JSON.stringify(quest));
    return true;
  } catch {
    return false;
  }
}

/** The game's name for a bot: bots join as `bot-<id>` (lib/bot-visitor.ts). */
export function gameBotUuid(botId: string): string {
  return `bot-${botId}`;
}

/**
 * The room's address with the owner's choices for the game (`#questArea=…&questHost=…`, read by the game's
 * QuestHash.ts). A paused quest visits the plain room.
 */
export function questVisitUrl(roomPath: string, quest: PublishedQuest | null): string {
  if (!quest || quest.status !== 'live') return roomPath;
  const parts: string[] = [];
  if (quest.paths.explore && quest.area) parts.push(`questArea=${encodeURIComponent(quest.area.name)}`);
  const host =
    quest.host.kind === 'bot' ? `bot:${gameBotUuid(quest.host.id)}` : quest.host.kind === 'area' ? `area:${quest.host.name}` : 'none';
  parts.push(`questHost=${encodeURIComponent(host)}`);
  return `${roomPath}#${parts.join('&')}`;
}
