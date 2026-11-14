import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { Agent37Client } from '@/lib/agent37/client';
import { imageFiles } from '@/lib/agent37/image-files';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * The image every Brick computer is made from, built on Agent37 by Orbit itself (build handoff v2, step 4): no registry, no local Docker, and
 * nothing for a person to do. The build is free and runs on Agent37; Orbit only packs the folder, uploads it, starts it, and reads how
 * it ended. Each sweep moves it one step:
 *
 *   no build of this content yet -> start one -> (building) -> succeeded: the image is ready, and its revision is kept
 *                                                           -> failed: tried again later, with longer waits, and never in a tight loop
 *
 * A machine is only made once the image is ready, and a machine made from an older revision is moved to the new one when it next wakes.
 * The content of the image (these files) is hashed: changing a script changes the hash, and so starts a new build by itself.
 */

export const IMAGE_NAME = 'universe-brick';
/** The agent's gateway port when none is given (Agent37's hermes-base serves its chat API here). */
export const IMAGE_PORT = 3737;

const BUILD_TIMEOUT_MS = 60 * 60 * 1000;
/** A failed build is tried again after this, doubling each time, up to the cap. */
const RETRY_BASE_MS = 5 * 60 * 1000;
const RETRY_CAP_MS = 6 * 60 * 60 * 1000;
const SETTING_KEY = 'computer-image';

export interface ImageState {
  /** Of the image's content (the files), so a change starts a new build. */
  hash: string;
  state: 'building' | 'ready' | 'failed';
  buildId: string | null;
  revision: number | null;
  startedAt: string;
  failures: number;
  /** The reason a build failed, in Agent37's words (short), for the one who looks. */
  error: string | null;
}

export interface ImageStore {
  get(): Promise<ImageState | null>;
  set(state: ImageState): Promise<void>;
  /**
   * Takes the one right to start a build, so two sweeps (or two Orbit processes) never both start one. Returns the state that was written
   * ("building", no build id yet), or null when someone else holds the right. Without it (a plain store) every caller may start.
   */
  claim?(hash: string, now: Date): Promise<ImageState | null>;
}

/** How long a claimed start may take before it is taken to have died and another sweep may start the build. */
export const CLAIM_MS = 2 * 60 * 1000;

export const dbImageStore: ImageStore = {
  async get() {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
    if (!row) return null;
    {
      const value = (row.value && typeof row.value === 'object' ? row.value : {}) as Partial<ImageState>;
      return typeof value.hash === 'string' && (value.state === 'building' || value.state === 'ready' || value.state === 'failed')
        ? { hash: value.hash, state: value.state, buildId: value.buildId ?? null, revision: typeof value.revision === 'number' ? value.revision : null, startedAt: value.startedAt ?? new Date(0).toISOString(), failures: value.failures ?? 0, error: value.error ?? null }
        : null;
    }
  },
  async set(state) {
    const value = state as unknown as Prisma.InputJsonValue;
    await prisma.appSetting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value }, update: { value } });
  },
  async claim(hash, now) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('computer-image-build'))`;
      const row = await tx.appSetting.findUnique({ where: { key: SETTING_KEY } });
      const value = (row?.value && typeof row.value === 'object' ? row.value : {}) as Partial<ImageState>;
      const same = value.hash === hash;
      // Someone claimed it a moment ago and has not yet recorded the build: it is theirs
      if (same && value.state === 'building' && !value.buildId && value.startedAt && now.getTime() - new Date(value.startedAt).getTime() < CLAIM_MS) return null;
      const marker: ImageState = { hash, state: 'building', buildId: null, revision: null, startedAt: now.toISOString(), failures: same ? (value.failures ?? 0) : 0, error: null };
      const json = marker as unknown as Prisma.InputJsonValue;
      await tx.appSetting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value: json }, update: { value: json } });
      return marker;
    });
  },
};

/** A tar of the files (ustar, one level, no directories), the same bytes for the same files. */
export function tarOf(files: Array<{ name: string; mode: number; text: string }>): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    const body = Buffer.from(file.text, 'utf8');
    const header = Buffer.alloc(512);
    const put = (text: string, at: number, length: number) => header.write(text.slice(0, length), at, 'ascii');
    const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, '0') + '\0';
    put(file.name, 0, 100);
    put(octal(file.mode, 8), 100, 8);
    put(octal(0, 8), 108, 8);
    put(octal(0, 8), 116, 8);
    put(octal(body.length, 12), 124, 12);
    put(octal(0, 12), 136, 12);
    header.write('        ', 148, 'ascii');
    header.write('0', 156, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    parts.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export interface ImageContext {
  hash: string;
  gzipped: Buffer;
}

export function imageContext(): ImageContext {
  const tar = tarOf(imageFiles());
  return { hash: createHash('sha256').update(tar).digest('hex').slice(0, 16), gzipped: gzipSync(tar, { level: 9 }) };
}

/** Moves the image one step on and says where it stands. Never throws: a call that failed is tried again by the next sweep. */
export async function ensureImage(client: Agent37Client, store: ImageStore = dbImageStore, now: Date = new Date()): Promise<ImageState> {
  const context = imageContext();
  let state = await store.get();
  let justMade = false;
  try {
    if (state && state.hash === context.hash) {
      if (state.state === 'ready') return state;
      if (state.state === 'building' && state.buildId) {
        const build = await client.templateBuild(state.buildId);
        if (build.status === 'succeeded') {
          state = { ...state, state: 'ready', revision: build.template?.revision ?? null, error: null };
          await store.set(state);
          return state;
        }
        if (build.status === 'failed') {
          console.error('[Computer] The computer image did not build:', build.error?.code ?? 'failed', build.error?.message ?? '', build.log.slice(-400));
          state = { ...state, state: 'failed', failures: state.failures + 1, error: (build.error?.message || build.error?.code || 'failed').slice(0, 300) };
          await store.set(state);
          return state;
        }
        if (now.getTime() - new Date(state.startedAt).getTime() > BUILD_TIMEOUT_MS) {
          state = { ...state, state: 'failed', failures: state.failures + 1, error: 'The build took too long' };
          await store.set(state);
        }
        return state;
      }
      if (state.state === 'failed') {
        const wait = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, state.failures - 1));
        if (now.getTime() - new Date(state.startedAt).getTime() < wait) return state;
      }
    }
    // No build of this content yet, or the last one failed and its wait is over: start one, if no other sweep is starting it right now
    if (store.claim) {
      const claimed = await store.claim(context.hash, now);
      if (!claimed) return (await store.get()) ?? state ?? { hash: context.hash, state: 'building', buildId: null, revision: null, startedAt: now.toISOString(), failures: 0, error: null };
      state = claimed;
      justMade = true;
    }
    const created = await client.createTemplateBuild({ name: IMAGE_NAME, sizeBytes: context.gzipped.length, defaultPort: IMAGE_PORT });
    // Kept before the upload, so a build that was started is never started twice if what follows is cut short
    state = { hash: context.hash, state: 'building', buildId: created.id, revision: null, startedAt: now.toISOString(), failures: state && state.hash === context.hash ? state.failures : 0, error: null };
    await store.set(state);
    justMade = true;
    await client.uploadTemplateContext(created.uploadUrl, context.gzipped);
    await client.startTemplateBuild(created.id);
    return state;
  } catch (error) {
    console.error('[Computer] Could not move the computer image on:', error instanceof Error ? error.message : 'unknown');
    // A build that was made but could not be uploaded or started is a failure (the next try is after the wait); a poll that failed is not
    if (justMade && state) {
      state = { ...state, state: 'failed', failures: state.failures + 1, error: 'The build could not be started' };
      await store.set(state).catch(() => undefined);
    }
    return state ?? { hash: context.hash, state: 'failed', buildId: null, revision: null, startedAt: now.toISOString(), failures: 1, error: 'The image could not be started' };
  }
}

/** The image is ready: a machine may be made from it. */
export const imageReady = (state: ImageState | null | undefined): boolean => state?.state === 'ready';
