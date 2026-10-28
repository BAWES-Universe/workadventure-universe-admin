import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { validateServiceToken } from '@/lib/service-tokens';
import { CHAT_KINDS } from '@/lib/artifacts';
import { BotFileError, FILE_KINDS, FILE_SOURCES, MAX_FILE_NAME_LENGTH, TEXT_PIECE_CHARS } from '@/lib/bot-files';

/**
 * The routes of files in bot chats (game #1508) are called only by the bot server (BOT_SERVICE_TOKEN, or the admin token
 * it falls back to). No browser and no manager's session reaches them, so no Orbit page can list a person's files.
 */
function hasAdminToken(request: NextRequest): boolean {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  const expected = process.env.ADMIN_API_TOKEN;
  return !!token && !!expected && token === expected;
}

/**
 * One piece of a file's text in JSON (text comes in pieces, so this is the same whatever is kept): up to four bytes a
 * character, with room for escapes and the rest of the body. About 6 MB.
 */
const bodyRoom = () => TEXT_PIECE_CHARS * 6 + 64 * 1024;

async function readBody(request: NextRequest): Promise<unknown> {
  const room = bodyRoom();
  const tooLarge = () => new BotFileError('too_large', 413, 'The request is too large.');
  if (Number(request.headers.get('content-length')) > room) throw tooLarge();
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    if (read > room) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

/** Wraps one route: the bot server's token, the JSON body, and the answer for each way it can end. */
export function botFileRoute<B extends z.ZodType>(name: string, bodySchema: B, handler: (body: z.infer<B>) => Promise<unknown>) {
  return async (request: NextRequest) => {
    try {
      if (!validateServiceToken(request) && !hasAdminToken(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      const parsed = bodySchema.safeParse(await readBody(request));
      if (!parsed.success) {
        // Where the body is wrong, never what it held
        return NextResponse.json({ error: 'Invalid request data', details: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) }, { status: 400 });
      }
      const answer = await handler(parsed.data);
      return NextResponse.json(answer, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      if (error instanceof BotFileError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
      // Never a file name or its text: only where it broke
      Sentry.captureException(error, { tags: { area: 'bot-files', route: name } });
      console.error(`Error in ${name}:`, error instanceof Error ? error.message : 'unknown');
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  };
}

const personSchema = z
  .object({
    signedIn: z.boolean(),
    identifier: z.string().trim().min(1).max(320).nullish(),
    name: z.string().max(200).nullish(),
  })
  .strict()
  .refine((person) => !person.signedIn || !!person.identifier, { message: 'A signed-in person needs an identifier', path: ['identifier'] });

const chatSchema = z.object({ kind: z.enum(CHAT_KINDS), ref: z.string().trim().min(1).max(255) }).strict();

const botCall = { botId: z.string().trim().min(1).max(255), person: personSchema, chat: chatSchema };

const storeSchema = z.union([
  z.object({ bucket: z.string().min(1).max(255), fileId: z.string().min(1).max(255) }).strict(),
  z.object({ url: z.string().min(1).max(2048) }).strict(),
]);

export const addSchema = z
  .object({
    ...botCall,
    source: z.enum(FILE_SOURCES),
    kind: z.enum(FILE_KINDS),
    name: z.string().max(MAX_FILE_NAME_LENGTH * 4),
    mimeType: z.string().max(255).nullish(),
    sizeBytes: z.number().int().min(0).max(2147483647).nullish(),
    store: storeSchema,
    line: z.string().max(2000).nullish(),
    madeWith: z.string().max(400).nullish(),
    // Kept up to "Text kept from a file"; one request carries up to a piece of it
    madePrompt: z.string().max(TEXT_PIECE_CHARS).nullish(),
    lengthSeconds: z.number().int().min(0).max(2147483647).nullish(),
    pages: z.number().int().min(0).max(2147483647).nullish(),
  })
  .strict();

const shortId = z.string().trim().min(2).max(12);

export const getSchema = z.object({ ...botCall, ref: shortId }).strict();

export const keepTextSchema = z
  .object({
    ...botCall,
    ref: shortId,
    // A piece over the size is answered 413 by keepFileText, so the bot server is told what to send
    text: z.string().max(TEXT_PIECE_CHARS * 2).nullish(),
    from: z.number().int().min(0).max(2147483647).nullish(),
    last: z.boolean().nullish(),
    failed: z.boolean().optional(),
  })
  .strict();

const day = z.string().max(40).nullish();

export const findSchema = z
  .object({
    ...botCall,
    words: z.string().max(500).nullish(),
    kinds: z.array(z.enum([...FILE_KINDS, 'artifact'] as [string, ...string[]])).max(6).nullish(),
    source: z.enum(FILE_SOURCES).nullish(),
    since: day,
    until: day,
    page: z.number().int().min(1).max(100_000).nullish(),
    // The "Files found in one search" setting's range
    limit: z.number().int().min(1).max(100),
  })
  .strict();

export const readSchema = z
  .object({
    ...botCall,
    ref: shortId,
    at: z.number().int().min(0).max(2147483647).nullish(),
    // The "Reads from a kept file" setting's range
    chars: z.number().int().min(1).max(5_000_000),
  })
  .strict();
