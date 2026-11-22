/**
 * The owner's two routes for one computer job (computers full plan, piece 2): tell it something new (note) and read its Activity. What each answers,
 * and that only a signed-in owner reaches the library at all.
 */
import { NextRequest } from 'next/server';
import { POST as noteRoute } from '@/app/api/bricks/[id]/computer/jobs/[jobId]/note/route';
import { GET as activityRoute } from '@/app/api/bricks/[id]/computer/jobs/[jobId]/activity/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import * as notesLib from '@/lib/computer-job-notes';
import * as stepsLib from '@/lib/computer-job-steps';

jest.mock('@/lib/db', () => ({ prisma: { user: { findUnique: jest.fn() } } }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/computer-job-notes', () => ({ NOTE_MAX: 4000, addJobNote: jest.fn() }));
jest.mock('@/lib/computer-job-steps', () => ({ jobActivity: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const db = prisma as unknown as { user: { findUnique: jest.Mock } };
const session = getSessionUser as jest.Mock;
const notes = notesLib as jest.Mocked<typeof notesLib>;
const steps = stepsLib as jest.Mocked<typeof stepsLib>;

const BRICK = 'brick-1';
const JOB = 'job-1';
const jobParams = { params: Promise.resolve({ id: BRICK, jobId: JOB }) };
const req = (path: string, method: string, body?: unknown) => new NextRequest(`http://localhost:3333${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const notePath = `/api/bricks/${BRICK}/computer/jobs/${JOB}/note`;
const activityPath = `/api/bricks/${BRICK}/computer/jobs/${JOB}/activity`;

beforeEach(() => {
  jest.resetAllMocks();
  session.mockResolvedValue({ id: 'u-sara' });
  db.user.findUnique.mockResolvedValue({ isGuest: false });
});

describe('a note to one job', () => {
  it('is for a signed-in owner: nobody gets a 401, a guest a 403, and nothing is kept', async () => {
    session.mockResolvedValue(null);
    expect((await noteRoute(req(notePath, 'POST', { text: 'x' }), jobParams)).status).toBe(401);
    session.mockResolvedValue({ id: 'g1' });
    db.user.findUnique.mockResolvedValue({ isGuest: true });
    expect((await noteRoute(req(notePath, 'POST', { text: 'x' }), jobParams)).status).toBe(403);
    expect(notes.addJobNote).not.toHaveBeenCalled();
  });

  it('answers the computer and the note; the job not this Brick’s is 404; over and ending are 409 with their reason; an empty or unknown body is 400', async () => {
    notes.addJobNote.mockResolvedValue({ ok: true, view: { job: { id: JOB } }, note: { seq: 2, delivery: 'now' } } as never);
    const ok = await noteRoute(req(notePath, 'POST', { text: '  use 12 March ' }), jobParams);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ computer: { job: { id: JOB } }, note: { seq: 2, delivery: 'now' } });
    expect(notes.addJobNote).toHaveBeenLastCalledWith(BRICK, 'u-sara', JOB, 'use 12 March');
    notes.addJobNote.mockResolvedValue({ ok: false, reason: 'not_found' });
    expect((await noteRoute(req(notePath, 'POST', { text: 'x' }), jobParams)).status).toBe(404);
    for (const reason of ['over', 'ending'] as const) {
      notes.addJobNote.mockResolvedValue({ ok: false, reason });
      const refused = await noteRoute(req(notePath, 'POST', { text: 'x' }), jobParams);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ reason });
    }
    notes.addJobNote.mockClear();
    for (const body of [{ text: '   ' }, {}, { text: 'x', more: 1 }, { text: 'x'.repeat(4001) }]) expect((await noteRoute(req(notePath, 'POST', body), jobParams)).status).toBe(400);
    expect(notes.addJobNote).not.toHaveBeenCalled();
  });
});

describe('a job’s Activity', () => {
  it('answers the job and its lines; a job that is not this owner’s Brick’s is 404', async () => {
    steps.jobActivity.mockResolvedValue({ ok: true, job: { id: JOB, title: 'Visa form', status: 'running' }, steps: [{ key: 'step:1', seq: 1, kind: 'step', label: 'Opening the visa site', detail: null, at: new Date('2026-11-23T00:00:00Z') }] });
    const read = await activityRoute(req(activityPath, 'GET'), jobParams);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ job: { id: JOB, title: 'Visa form', status: 'running' }, steps: [{ key: 'step:1', seq: 1, kind: 'step', label: 'Opening the visa site', detail: null, at: '2026-11-23T00:00:00.000Z' }] });
    expect(steps.jobActivity).toHaveBeenLastCalledWith(BRICK, 'u-sara', JOB);
    steps.jobActivity.mockResolvedValue({ ok: false, reason: 'not_found' });
    expect((await activityRoute(req(activityPath, 'GET'), jobParams)).status).toBe(404);
  });
});
