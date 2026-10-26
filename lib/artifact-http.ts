import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { validateServiceToken } from '@/lib/service-tokens';
import { ARTIFACT_KINDS, ArtifactError, CHAT_KINDS, MAX_ARTIFACT_BYTES, type ArtifactKind } from '@/lib/artifacts';

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

/** Wraps one artifact route: the caller's token, the JSON body, and the answer for each way it can end. */
export function artifactRoute<B extends z.ZodType>(
  name: string,
  caller: ArtifactCaller,
  bodySchema: B,
  handler: (body: z.infer<B>, params: Record<string, string>) => Promise<unknown>,
) {
  return async (request: NextRequest, context?: { params: Params }) => {
    try {
      if (!authorised(request, caller)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      const parsed = bodySchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return NextResponse.json({ error: 'Invalid request data', details: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) }, { status: 400 });
      const answer = await handler(parsed.data, context ? await context.params : {});
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

export const viewerSchema = z.object({ person: personSchema, inChat: z.boolean() }).strict();

const botCall = { botId: z.string().trim().min(1).max(255), person: personSchema, chat: chatSchema };

export const makeSchema = z
  .object({
    ...botCall,
    title: text(500),
    kind: z.enum(ARTIFACT_KINDS as unknown as [ArtifactKind, ...ArtifactKind[]]),
    // A little above the cap so the size rule, not the parser, gives the answer
    content: text(MAX_ARTIFACT_BYTES * 2),
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
      .array(z.object({ old: text(MAX_ARTIFACT_BYTES), new: text(MAX_ARTIFACT_BYTES), all: z.boolean().optional() }).strict())
      .max(50)
      .nullish(),
    content: text(MAX_ARTIFACT_BYTES * 2).nullish(),
    summary: text(1000).nullish(),
    title: text(500).nullish(),
  })
  .strict();

export const readSchema = z.object({ ...botCall, version: versionNumber.nullish() }).strict();

export const inChatSchema = z.object(botCall).strict();

export const openSchema = z.object({ viewer: viewerSchema, version: versionNumber.nullish() }).strict();

export const viewerOnlySchema = z.object({ viewer: viewerSchema }).strict();

export const shareSchema = z.object({ viewer: viewerSchema, openScope: z.string().optional(), changeScope: z.string().optional() }).strict();

export const restoreSchema = z.object({ viewer: viewerSchema, number: versionNumber }).strict();

export const mineSchema = z.object({ person: personSchema }).strict();

/** A version number from the address, or a 404: there is no version "abc". */
export function versionParam(value: string | undefined): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_VERSION_NUMBER) throw new ArtifactError('version_not_found', 404, 'No such version.');
  return number;
}
