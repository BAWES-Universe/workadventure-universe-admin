/** The routes the bot server uses to hear what Brick is to tell about computer jobs, and to say it was told: who may ask, and what each answers. */
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/computer/jobs/reports/route';
import * as report from '@/lib/computer-report';

jest.mock('@/lib/computer-report');
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const lib = report as jest.Mocked<typeof report>;
const TOKEN = 'bot-server-secret';
const before = process.env.BOT_SERVICE_TOKEN;

const call = (init: { method?: string; body?: unknown; token?: string | null } = {}) =>
  new NextRequest('http://localhost:3333/api/computer/jobs/reports', {
    method: init.method ?? 'POST',
    headers: init.token === null ? {} : { Authorization: `Bearer ${init.token ?? TOKEN}` },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

beforeEach(() => {
  jest.resetAllMocks();
  // The automock empties an array export: the kinds a reader may opt in to are the real ones
  (lib as unknown as { OPT_IN_KINDS: string[] }).OPT_IN_KINDS = ['late'];
  process.env.BOT_SERVICE_TOKEN = TOKEN;
});
afterAll(() => {
  if (before === undefined) delete process.env.BOT_SERVICE_TOKEN;
  else process.env.BOT_SERVICE_TOKEN = before;
});

describe('GET /api/computer/jobs/reports', () => {
  it('is for the bot server’s token only', async () => {
    expect((await GET(call({ method: 'GET', token: null }))).status).toBe(401);
    expect((await GET(call({ method: 'GET', token: 'wrong' }))).status).toBe(401);
    expect(lib.reportsToTell).not.toHaveBeenCalled();
  });

  it('gives what is to be told, never cached', async () => {
    lib.reportsToTell.mockResolvedValue([{ key: 'k', jobId: 'j' } as never]);
    const response = await GET(call({ method: 'GET' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ reports: [{ key: 'k', jobId: 'j' }] });
  });

  it('sends the follow-up kind only to a reader that asked for it (?accepts=late): an older game asks for nothing and is asked for nothing more', async () => {
    lib.reportsToTell.mockResolvedValue([]);
    const ask = (query: string) => GET(new NextRequest(`http://localhost:3333/api/computer/jobs/reports${query}`, { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } }));
    await ask('');
    expect(lib.reportsToTell).toHaveBeenLastCalledWith(50, expect.any(Date), { accepts: [] });
    await ask('?accepts=late');
    expect(lib.reportsToTell).toHaveBeenLastCalledWith(50, expect.any(Date), { accepts: ['late'] });
    // Words it does not know are dropped, never passed on
    await ask('?accepts=late,%20sold,');
    expect(lib.reportsToTell).toHaveBeenLastCalledWith(50, expect.any(Date), { accepts: ['late'] });
    await ask('?accepts=sold');
    expect(lib.reportsToTell).toHaveBeenLastCalledWith(50, expect.any(Date), { accepts: [] });
  });

  it('is a plain server error, with nothing of the cause, when it cannot read', async () => {
    lib.reportsToTell.mockRejectedValue(new Error('db down'));
    const response = await GET(call({ method: 'GET' }));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('db down');
  });
});

describe('POST /api/computer/jobs/reports', () => {
  it('is for the bot server’s token only', async () => {
    expect((await POST(call({ token: null, body: { jobId: 'j', kind: 'done' } }))).status).toBe(401);
    expect(lib.keepReportTold).not.toHaveBeenCalled();
  });

  it('keeps an ending, and a wait with its number', async () => {
    lib.keepReportTold.mockResolvedValue(true);
    expect((await POST(call({ body: { jobId: 'j', kind: 'done' } }))).status).toBe(200);
    expect(lib.keepReportTold).toHaveBeenLastCalledWith('j', 'done', undefined, { delivered: true });
    expect((await POST(call({ body: { jobId: 'j', kind: 'needs', seq: 2 } }))).status).toBe(200);
    expect(lib.keepReportTold).toHaveBeenLastCalledWith('j', 'needs', 2, { delivered: true });
  });

  it('keeps an ending that can never be delivered as that, with why, never as told', async () => {
    lib.keepReportTold.mockResolvedValue(true);
    expect((await POST(call({ body: { jobId: 'j', kind: 'done', outcome: 'undeliverable', why: 'no_chat' } }))).status).toBe(200);
    expect(lib.keepReportTold).toHaveBeenLastCalledWith('j', 'done', undefined, { delivered: false, why: 'no_chat' });
    // Undeliverable without a reason, or with one that is not a reason, is refused
    expect((await POST(call({ body: { jobId: 'j', kind: 'done', outcome: 'undeliverable' } }))).status).toBe(400);
    expect((await POST(call({ body: { jobId: 'j', kind: 'done', outcome: 'undeliverable', why: 'because' } }))).status).toBe(400);
    // Delivered says nothing more than that
    expect((await POST(call({ body: { jobId: 'j', kind: 'done', outcome: 'delivered' } }))).status).toBe(200);
    expect(lib.keepReportTold).toHaveBeenLastCalledWith('j', 'done', undefined, { delivered: true });
  });

  it('keeps the follow-up as told, and as never to be told when it can never be delivered', async () => {
    lib.keepReportTold.mockResolvedValue(true);
    expect((await POST(call({ body: { jobId: 'j', kind: 'late' } }))).status).toBe(200);
    expect(lib.keepReportTold).toHaveBeenLastCalledWith('j', 'late', undefined, { delivered: true });
    expect((await POST(call({ body: { jobId: 'j', kind: 'late', outcome: 'undeliverable', why: 'no_chat' } }))).status).toBe(200);
    expect(lib.keepReportTold).toHaveBeenLastCalledWith('j', 'late', undefined, { delivered: false, why: 'no_chat' });
    // The follow-up's ack says back the `through` the report carried, so only what it told is marked told; one that is not a time is refused
    expect((await POST(call({ body: { jobId: 'j', kind: 'late', through: '2026-11-21T10:00:00.000Z' } }))).status).toBe(200);
    expect(lib.keepReportTold).toHaveBeenLastCalledWith('j', 'late', undefined, { delivered: true }, undefined, { through: new Date('2026-11-21T10:00:00.000Z') });
    expect((await POST(call({ body: { jobId: 'j', kind: 'late', through: 'yesterday' } }))).status).toBe(400);
    lib.keepReportTold.mockResolvedValue(false);
    expect((await POST(call({ body: { jobId: 'gone', kind: 'late' } }))).status).toBe(404);
  });

  it('refuses what it does not understand, and says not found for a job that is not there', async () => {
    expect((await POST(call({ body: { jobId: 'j', kind: 'sold' } }))).status).toBe(400);
    expect((await POST(call({ body: { kind: 'done' } }))).status).toBe(400);
    expect((await POST(call({ body: { jobId: 'j', kind: 'needs', seq: -1 } }))).status).toBe(400);
    lib.keepReportTold.mockResolvedValue(false);
    expect((await POST(call({ body: { jobId: 'gone', kind: 'done' } }))).status).toBe(404);
  });
});
