/**
 * The voice note routes (game: every bot hears voice notes) answer the bot server's service token and nobody else, and pass each
 * library's refusal on with its status. What they do is in voice-notes-db.test.ts, against a real database.
 */
import { NextRequest } from 'next/server';
import { POST as reserve } from '@/app/api/voice-notes/turns/route';
import { PATCH as record } from '@/app/api/voice-notes/turns/[id]/route';
import { POST as lease } from '@/app/api/voice-notes/turns/[id]/lease/route';
import { POST as addCleanup } from '@/app/api/voice-notes/cleanups/route';
import { POST as claimCleanups } from '@/app/api/voice-notes/cleanups/claim/route';
import { PATCH as settleCleanup } from '@/app/api/voice-notes/cleanups/[id]/route';
import { VoiceNoteError, leaseVoiceNoteStage, recordVoiceNote, reserveVoiceNote } from '@/lib/voice-note-turns';
import { addVoiceNoteCleanup, claimVoiceNoteCleanups, settleVoiceNoteCleanup } from '@/lib/voice-note-cleanups';

jest.mock('@/lib/db', () => ({ prisma: {} }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('@/lib/voice-note-turns', () => ({
  ...jest.requireActual('@/lib/voice-note-turns'),
  reserveVoiceNote: jest.fn(),
  leaseVoiceNoteStage: jest.fn(),
  recordVoiceNote: jest.fn(),
}));
jest.mock('@/lib/voice-note-cleanups', () => ({
  ...jest.requireActual('@/lib/voice-note-cleanups'),
  addVoiceNoteCleanup: jest.fn(),
  claimVoiceNoteCleanups: jest.fn(),
  settleVoiceNoteCleanup: jest.fn(),
}));

const TOKEN = 'bot-server-secret';
const asBotServer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const call = (method: string, headers: Record<string, string> = asBotServer, body: unknown = {}) =>
  new NextRequest('http://localhost:3333/api/voice-notes/x', { method, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const ctx = { params: Promise.resolve({ id: 't-1' }) };

const doors: [string, (headers?: Record<string, string>, body?: unknown) => Promise<Response>, jest.Mock][] = [
  ['reserving a note', (headers, body) => reserve(call('POST', headers, body)), reserveVoiceNote as jest.Mock],
  ['leasing a stage', (headers, body) => lease(call('POST', headers, body), ctx), leaseVoiceNoteStage as jest.Mock],
  ['recording what happened', (headers, body) => record(call('PATCH', headers, body), ctx), recordVoiceNote as jest.Mock],
  ['adding a cleanup', (headers, body) => addCleanup(call('POST', headers, body)), addVoiceNoteCleanup as jest.Mock],
  ['handing out cleanups', (headers, body) => claimCleanups(call('POST', headers, body)), claimVoiceNoteCleanups as jest.Mock],
  ['settling a cleanup', (headers, body) => settleCleanup(call('PATCH', headers, body), ctx), settleVoiceNoteCleanup as jest.Mock],
];

beforeAll(() => {
  process.env.BOT_SERVICE_TOKEN = TOKEN;
});
beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

it.each(doors)('turns down anyone without the service token: %s', async (_name, door, lib) => {
  expect((await door({ 'content-type': 'application/json' })).status).toBe(401);
  expect((await door({ authorization: 'Bearer nope' })).status).toBe(401);
  expect(lib).not.toHaveBeenCalled();
});

it.each(doors)('answers what the library says, never cached: %s', async (_name, door, lib) => {
  lib.mockResolvedValue([]);
  const response = await door(asBotServer, { a: 1 });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
});

it.each(doors)('passes a refusal on with its status, and hides anything else: %s', async (_name, door, lib) => {
  lib.mockRejectedValue(new VoiceNoteError('Another bot server has this turn now', 409));
  expect((await door()).status).toBe(409);
  lib.mockRejectedValue(new Error('db down'));
  const response = await door();
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'Internal server error' });
});

it('turns down a body that is not a JSON object', async () => {
  expect((await reserve(call('POST', asBotServer, 'not json'))).status).toBe(400);
  expect((await reserve(call('POST', asBotServer, [1]))).status).toBe(400);
  expect(reserveVoiceNote).not.toHaveBeenCalled();
});
