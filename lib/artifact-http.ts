import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { validateServiceToken } from '@/lib/service-tokens';
import { ARTIFACT_KINDS, ArtifactError, CHAT_KINDS, LARGEST_ARTIFACT_BYTES, tooLarge, tooMuchMedia, type ArtifactKind, type MediaUpload } from '@/lib/artifacts';
import { artifactBytes, artifactMediaBytes } from '@/lib/bot-limit-values';
import { getServerLimits } from '@/lib/bot-limits';

/**
 * The routes of live artifacts (game #1422, Orbit #622) are called by servers, never by a browser: the bot server
 * (BOT_SERVICE_TOKEN, or the admin token it falls back to) for make, change and read, and the game's server
 * (ADMIN_API_TOKEN) for the rest, on behalf of the person it names. A person who may not see an artifact hears the same
 * as for one that does not exist.
 */
export type ArtifactCaller = 'bot' | 'game';

function hasAdminToken(request: NextRequest): boolean {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  const expected = process.env.ADMIN_API_TOKEN;
  return !!token && !!expected && token === expected;
}

function authorised(request: NextRequest, caller: ArtifactCaller): boolean {
  return caller === 'bot' ? validateServiceToken(request) || hasAdminToken(request) : hasAdminToken(request);
}

type Params = Promise<Record<string, string>>;

/**
 * How many times the size of one version a request may carry (Orbit #669 review). A change can name the whole file as
 * edits, old and new, with the JSON around it, so a real request stays well under it; a runaway one is turned down
 * before it is read, with the same answer as a file over the size.
 */
const BODY_ROOM = 4;

/** The room a form's boundaries and part headers take beside the media themselves. */
const FORM_ROOM = 1024 * 1024;

/** What a route reads: the JSON body, and the media sent with it (#1510). */
interface Body {
  json: unknown;
  media: MediaUpload[];
}

/**
 * The body, read only up to the room above; `json` is null when it is not JSON. A make or a change that carries songs,
 * images or videos comes as multipart/form-data instead: the same JSON in a `request` part, and one `media` part per
 * file, named as the page uses it (`song.mp3`). Only routes that take media accept the form.
 */
async function readBody(request: NextRequest, takesMedia: boolean): Promise<Body> {
  const limits = (await getServerLimits()).artifacts;
  const maxBytes = artifactBytes(limits);
  const maxMediaBytes = artifactMediaBytes(limits);
  const contentType = request.headers.get('content-type') ?? '';
  const isForm = takesMedia && /^multipart\/form-data/i.test(contentType);
  const room = maxBytes * BODY_ROOM + (isForm ? maxMediaBytes + FORM_ROOM : 0);
  // A form that is too big may be over on its page or on its media: the answer names both limits
  const over = () => (isForm && maxMediaBytes > 0 ? new ArtifactError('too_large', 413, `${tooLarge(maxBytes).message} ${tooMuchMedia(maxMediaBytes).message}`) : tooLarge(maxBytes));
  if (Number(request.headers.get('content-length')) > room) throw over();
  if (!request.body) return { json: null, media: [] };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    if (read > room) {
      await reader.cancel();
      throw over();
    }
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks);
  if (!isForm) return { json: parseJson(raw.toString('utf8')), media: [] };
  let form: FormData;
  try {
    form = await new Response(raw, { headers: { 'content-type': contentType } }).formData();
  } catch {
    return { json: null, media: [] };
  }
  const part = form.get('request');
  const media: MediaUpload[] = [];
  for (const file of form.getAll('media')) {
    if (typeof file === 'string') return { json: null, media: [] };
    media.push({ name: file.name, contentType: file.type, body: new Uint8Array(await file.arrayBuffer()) });
  }
  return { json: typeof part === 'string' ? parseJson(part) : null, media };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Wraps one artifact route: the caller's token, the JSON body, and the answer for each way it can end. A route that
 * passes `{ media: true }` also takes songs, images and videos as a form (see readBody); its handler gets them third.
 */
export function artifactRoute<B extends z.ZodType>(
  name: string,
  caller: ArtifactCaller,
  bodySchema: B,
  handler: (body: z.infer<B>, params: Record<string, string>, media: MediaUpload[]) => Promise<unknown>,
  options: { media?: boolean } = {},
) {
  return async (request: NextRequest, context?: { params: Params }) => {
    try {
      if (!authorised(request, caller)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      const body = await readBody(request, options.media === true);
      const parsed = bodySchema.safeParse(body.json);
      if (!parsed.success) return NextResponse.json({ error: 'Invalid request data', details: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) }, { status: 400 });
      const answer = await handler(parsed.data, context ? await context.params : {}, body.media);
      return NextResponse.json(answer, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      if (error instanceof ArtifactError) {
        return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
      }
      // Never the content: only where it broke
      Sentry.captureException(error, { tags: { area: 'artifacts', route: name } });
      console.error(`Error in ${name}:`, error instanceof Error ? error.message : 'unknown');
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  };
}

const text = (max: number) => z.string().max(max);

export const personSchema = z
  .object({
    signedIn: z.boolean(),
    identifier: z.string().trim().min(1).max(320).nullish(),
    name: z.string().max(200).nullish(),
  })
  .strict()
  .refine((person) => !person.signedIn || !!person.identifier, { message: 'A signed-in person needs an identifier', path: ['identifier'] });

export const chatSchema = z.object({ kind: z.enum(CHAT_KINDS), ref: z.string().trim().min(1).max(255) }).strict();

/**
 * `inChat` is the game's word that the person is in the chat it names in `chat` right now. Orbit counts it only when that
 * is the chat the artifact was made in; with no `chat` it counts for nothing.
 */
export const viewerSchema = z.object({ person: personSchema, inChat: z.boolean(), chat: chatSchema.optional() }).strict();

const botCall = { botId: z.string().trim().min(1).max(255), person: personSchema, chat: chatSchema };

export const makeSchema = z
  .object({
    ...botCall,
    title: text(500),
    kind: z.enum(ARTIFACT_KINDS as unknown as [ArtifactKind, ...ArtifactKind[]]),
    // A little above the cap so the size rule, not the parser, gives the answer
    content: text(LARGEST_ARTIFACT_BYTES * 2),
    summary: text(1000).nullish(),
  })
  .strict();

/** A version number fits the database's 32-bit column, so a bigger one is turned down here instead of failing there. */
const MAX_VERSION_NUMBER = 2147483647;
const versionNumber = z.number().int().min(1).max(MAX_VERSION_NUMBER);

export const changeSchema = z
  .object({
    ...botCall,
    baseVersion: versionNumber.nullish(),
    edits: z
      .array(z.object({ old: text(LARGEST_ARTIFACT_BYTES), new: text(LARGEST_ARTIFACT_BYTES), all: z.boolean().optional() }).strict())
      .max(50)
      .nullish(),
    content: text(LARGEST_ARTIFACT_BYTES * 2).nullish(),
    summary: text(1000).nullish(),
    title: text(500).nullish(),
    // Names of media the new version leaves out (#1510); new media come as form parts
    dropMedia: z.array(text(200)).nullish(),
  })
  .strict();

export const readSchema = z.object({ ...botCall, version: versionNumber.nullish() }).strict();

export const inChatSchema = z.object(botCall).strict();

export const openSchema = z.object({ viewer: viewerSchema, version: versionNumber.nullish() }).strict();

export const viewerOnlySchema = z.object({ viewer: viewerSchema }).strict();

export const shareSchema = z.object({ viewer: viewerSchema, openScope: z.string().optional(), changeScope: z.string().optional() }).strict();

export const deleteSchema = z.object({ viewer: viewerSchema }).strict();

export const restoreSchema = z.object({ viewer: viewerSchema, number: versionNumber }).strict();

export const mineSchema = z.object({ person: personSchema }).strict();

/** Where a page of a list starts: 0 for the first, then the `next` the previous page gave. */
export const listOffset = z.number().int().min(0).max(1_000_000);

export const ownedListSchema = z.object({ person: personSchema, offset: listOffset.optional() }).strict();

export const chatListSchema = z.object({ viewer: viewerSchema.refine((viewer) => viewer.chat !== undefined, { message: 'Name the chat', path: ['chat'] }), offset: listOffset.optional() }).strict();

/** A version number from the address, or a 404: there is no version "abc". */
export function versionParam(value: string | undefined): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_VERSION_NUMBER) throw new ArtifactError('version_not_found', 404, 'No such version.');
  return number;
}
