/**
 * What was shared in nearby chats, kept for each signed-in person who was there (game #1424). The game sends each
 * image, video, link or file it showed in the nearby chat; this checks one before it is kept.
 */

export const NEARBY_SHARED_KINDS = ['media', 'link', 'file'] as const;
export type NearbySharedKind = (typeof NEARBY_SHARED_KINDS)[number];

/** Items one request may add, and items one page of the list holds at most. */
export const NEARBY_SHARED_MAX_PER_REQUEST = 50;
export const NEARBY_SHARED_PAGE_MAX = 100;

export interface NearbySharedItemInput {
  itemKey: string;
  kind: NearbySharedKind;
  name: string;
  link: string | null;
  fileId: string | null;
  mimeType: string | null;
  size: number | null;
  isVideo: boolean;
  senderName: string;
  mine: boolean;
  sentAt: Date;
}

// A sentAt more than this far ahead of the server's clock is someone else's clock gone wrong.
const FUTURE_SLACK_MS = 5 * 60 * 1000;
// An uploader file id: its UUID, with the file's extension kept.
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{1,10})?$/i;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  return text(value, max) ?? undefined;
}

function httpLink(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  const link = text(value, 2000);
  if (!link) return undefined;
  try {
    const url = new URL(link);
    return url.protocol === 'https:' || url.protocol === 'http:' ? link : undefined;
  } catch {
    return undefined;
  }
}

/** One item from the game, checked: null when anything about it is wrong. */
export function parseNearbySharedItem(value: unknown, now: Date = new Date()): NearbySharedItemInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;

  const itemKey = text(item.itemKey, 300);
  const kind = NEARBY_SHARED_KINDS.find((known) => known === item.kind);
  const name = text(item.name, 300);
  const senderName = text(item.senderName, 100);
  const link = httpLink(item.link);
  const fileId = optionalText(item.fileId, 200);
  const mimeType = optionalText(item.mimeType, 150);
  if (!itemKey || !kind || !name || !senderName || link === undefined || fileId === undefined || mimeType === undefined) {
    return null;
  }
  if (fileId !== null && !FILE_ID.test(fileId)) return null;
  // A link is where a link goes; an image, video or file is either an uploader file or a link to one.
  if (kind === 'link' ? link === null || fileId !== null : link === null && fileId === null) return null;

  let size: number | null = null;
  if (item.size !== undefined && item.size !== null) {
    if (typeof item.size !== 'number' || !Number.isInteger(item.size) || item.size < 0 || item.size > 2 ** 31 - 1) {
      return null;
    }
    size = item.size;
  }
  if (item.isVideo !== undefined && typeof item.isVideo !== 'boolean') return null;
  if (item.mine !== undefined && typeof item.mine !== 'boolean') return null;

  if (typeof item.sentAt !== 'string') return null;
  const sentAt = new Date(item.sentAt);
  if (Number.isNaN(sentAt.getTime()) || sentAt.getTime() > now.getTime() + FUTURE_SLACK_MS) return null;

  return {
    itemKey,
    kind,
    name,
    link,
    fileId,
    mimeType,
    size,
    isVideo: kind === 'media' && item.isVideo === true,
    senderName,
    mine: item.mine === true,
    sentAt,
  };
}
