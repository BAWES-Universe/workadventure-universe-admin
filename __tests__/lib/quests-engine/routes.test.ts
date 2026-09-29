/**
 * The session routes of the quest engine: who may call, what a body may say, and that a producer naming an
 * objective is ignored. The engine itself is exercised against the database in __tests__/integration/quests-engine.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({ prisma: {} }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/quests/engine', () => {
  const actual = jest.requireActual('@/lib/quests/engine');
  return {
    ...actual,
    ensureWelcomeChapterOnce: jest.fn(async () => undefined),
    recordObservation: jest.fn(),
    acceptQuest: jest.fn(),
    myQuests: jest.fn(),
    trackQuest: jest.fn(),
    stopFollowing: jest.fn(),
    removeFromLog: jest.fn(),
    knowCapability: jest.fn(),
    deleteActorQuestData: jest.fn(),
  };
});

import { getSessionUser } from '@/lib/auth-session';
import * as engine from '@/lib/quests/engine';
import { QuestEngineError } from '@/lib/quests/engine/errors';
import { GET as getQuests, DELETE as deleteQuests } from '@/app/api/me/quests/route';
import { POST as observe, OPTIONS as observeOptions } from '@/app/api/me/quests/observations/route';
import { POST as accept } from '@/app/api/me/quests/accept/route';
import { PUT as track } from '@/app/api/me/quests/tracked/route';
import { PUT as guidance } from '@/app/api/me/quests/guidance/route';
import { POST as stop } from '@/app/api/me/quests/[progressId]/stop/route';
import { DELETE as remove } from '@/app/api/me/quests/[progressId]/route';

const BASE = 'http://localhost:3333/api/me/quests';
const alice = { id: 'user-a', uuid: 'uuid-a', email: 'a@example.com', name: 'A', tags: [], isSuperAdmin: false };
const mocked = engine as unknown as Record<string, jest.Mock>;

function request(path: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_PLAY_URL = 'http://play.test';
  (getSessionUser as jest.Mock).mockResolvedValue(alice);
});

describe('/api/me/quests routes', () => {
  it('refuse a signed-out caller on every route', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    const params = { params: Promise.resolve({ progressId: 'p1' }) };
    const responses = await Promise.all([
      getQuests(request('', 'GET')),
      deleteQuests(request('', 'DELETE')),
      observe(request('/observations', 'POST', { eventId: 'e1', action: 'hello-exchanged' })),
      accept(request('/accept', 'POST', { key: 'welcome.meet' })),
      track(request('/tracked', 'PUT', { progressId: null, revision: 0 })),
      guidance(request('/guidance', 'PUT', { capabilityKey: 'walk' })),
      stop(request('/p1/stop', 'POST'), params),
      remove(request('/p1', 'DELETE'), params),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401, 401, 401, 401]);
    expect(mocked.recordObservation).not.toHaveBeenCalled();
    expect(mocked.acceptQuest).not.toHaveBeenCalled();
  });

  it('refuse an origin that is neither Orbit nor the game, and answer the game preflight', async () => {
    const denied = await observe(request('/observations', 'POST', { eventId: 'e1', action: 'hello-exchanged' }, { Origin: 'https://evil.test' }));
    expect(denied.status).toBe(403);
    expect(mocked.recordObservation).not.toHaveBeenCalled();
    const preflight = await observeOptions(request('/observations', 'OPTIONS', undefined, { Origin: 'http://play.test' }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('http://play.test');
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
  });

  it('an observation names the action and subject, never an objective; the caller is always the actor', async () => {
    mocked.recordObservation.mockResolvedValue({ observationId: 'o1', reused: false, applications: [], completed: [] });
    const response = await observe(
      request('/observations', 'POST', {
        eventId: 'evt:1',
        action: 'hello-exchanged',
        subject: 'bot-1',
        roomId: 'r1',
        occurredAt: '2026-09-29T13:00:00Z',
        evidence: { seconds: 3, objectiveId: 'obj-1' },
        objectiveId: 'obj-1',
        actorId: 'someone-else',
      }),
    );
    expect(response.status).toBe(200);
    expect(mocked.recordObservation).toHaveBeenCalledTimes(1);
    const [, input] = mocked.recordObservation.mock.calls[0];
    expect(input).toEqual({
      source: 'CLIENT',
      sourceId: 'game',
      eventId: 'evt:1',
      actorId: 'user-a',
      action: 'hello-exchanged',
      subject: 'bot-1',
      roomId: 'r1',
      occurredAt: new Date('2026-09-29T13:00:00Z'),
      evidence: { seconds: 3 },
    });
    expect(JSON.stringify(input)).not.toContain('obj-1');
  });

  it('rejects an observation that is not one', async () => {
    expect((await observe(request('/observations', 'POST', '{not json'))).status).toBe(400);
    expect((await observe(request('/observations', 'POST', { action: 'hello-exchanged' }))).status).toBe(400);
    expect((await observe(request('/observations', 'POST', { eventId: 'e1', action: 'Hello World' }))).status).toBe(400);
    expect((await observe(request('/observations', 'POST', { eventId: 'e1', action: 'x', occurredAt: 'yesterday' }))).status).toBe(400);
    expect(mocked.recordObservation).not.toHaveBeenCalled();
  });

  it('maps engine errors to statuses and carries their details', async () => {
    mocked.trackQuest.mockRejectedValue(new QuestEngineError('stale-revision', 'Another tab changed what you follow.', { progressId: 'p9', revision: 4 }));
    const conflict = await track(request('/tracked', 'PUT', { progressId: 'p1', revision: 3 }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'Another tab changed what you follow.', code: 'stale-revision', progressId: 'p9', revision: 4 });

    mocked.acceptQuest.mockRejectedValue(new QuestEngineError('out-of-scope', 'This quest is not offered here.'));
    expect((await accept(request('/accept', 'POST', { key: 'welcome.meet', roomId: 'r2' }))).status).toBe(403);
    mocked.acceptQuest.mockRejectedValue(new QuestEngineError('not-found', 'No such quest.'));
    expect((await accept(request('/accept', 'POST', { questId: 'nope' }))).status).toBe(404);
    expect((await accept(request('/accept', 'POST', {}))).status).toBe(400);
  });

  it('reads, stops, removes and clears only for the caller', async () => {
    mocked.myQuests.mockResolvedValue({ quests: [], tracked: { progressId: null, revision: 0 }, badges: [], points: 0, known: [] });
    expect((await getQuests(request('?roomId=r1', 'GET'))).status).toBe(200);
    expect(mocked.myQuests).toHaveBeenCalledWith({}, 'user-a', 'r1');

    mocked.stopFollowing.mockResolvedValue({ id: 'p1', status: 'STOPPED' });
    await stop(request('/p1/stop', 'POST'), { params: Promise.resolve({ progressId: 'p1' }) });
    expect(mocked.stopFollowing).toHaveBeenCalledWith({}, 'user-a', 'p1');

    mocked.removeFromLog.mockResolvedValue(undefined);
    expect((await remove(request('/p1', 'DELETE'), { params: Promise.resolve({ progressId: 'p1' }) })).status).toBe(204);
    expect(mocked.removeFromLog).toHaveBeenCalledWith({}, 'user-a', 'p1');

    mocked.knowCapability.mockResolvedValue({ capabilityKey: 'walk', state: 'KNOWN' });
    const known = await guidance(request('/guidance', 'PUT', { capabilityKey: 'walk' }));
    expect(await known.json()).toEqual({ capabilityKey: 'walk', state: 'known' });

    mocked.deleteActorQuestData.mockResolvedValue({ subjectToken: 'deleted:x', removed: { progress: 2 } });
    const cleared = await deleteQuests(request('', 'DELETE'));
    expect(await cleared.json()).toEqual({ removed: { progress: 2 } });
    expect(mocked.deleteActorQuestData).toHaveBeenCalledWith({}, { actorId: 'user-a', byToken: 'user-a', scope: 'quests' });
  });
});
