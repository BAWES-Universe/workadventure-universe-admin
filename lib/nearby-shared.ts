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
// An uploader file: the bucket it is kept in, then its id (a UUID, with the file's extension kept: the uploader keeps
// up to 16 characters of it, so "x.webmanifest" is one of its files too).
const FILE_ID =
  /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{1,16})?$/i;

// Half of an emoji's pair with no other half next to it.
const LONE_HALF = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // Postgres can't keep a NUL, and no name or link needs a control character or half an emoji.
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(LONE_HALF, '\uFFFD').trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

/** Like text(), but a longer value is cut to fit instead of turned down: a name or a key, never a link. */
function clippedText(value: unknown, max: number): string | null {
  const whole = text(value, Number.MAX_SAFE_INTEGER);
  // Never through the middle of an emoji: a lone half can't be saved as text.
  return whole ? whole.slice(0, max).replace(/[\uD800-\uDBFF]$/, '').trim() || null : null;
}

// Left empty counts as not given: a browser gives "" as the type of a file it doesn't know.
function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function optionalText(value: unknown, max: number): string | null | undefined {
  if (isBlank(value)) return null;
  return text(value, max) ?? undefined;
}

function httpLink(value: unknown): string | null | undefined {
  if (isBlank(value)) return null;
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

  const itemKey = clippedText(item.itemKey, 300);
  const kind = NEARBY_SHARED_KINDS.find((known) => known === item.kind);
  const name = clippedText(item.name, 300);
  const senderName = clippedText(item.senderName, 100);
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
