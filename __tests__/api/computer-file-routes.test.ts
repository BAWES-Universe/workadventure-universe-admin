/** The route the bot server uses to fetch a file a computer job made, to put it in the person's chat: who may ask, and what comes back. */
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/computer/jobs/[jobId]/files/[fileId]/route';
import * as cards from '@/lib/computer-file-cards';

jest.mock('@/lib/computer-file-cards');
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const lib = cards as jest.Mocked<typeof cards>;
const TOKEN = 'bot-server-secret';
const before = process.env.BOT_SERVICE_TOKEN;

const call = (token: string | null = TOKEN) =>
  GET(new NextRequest('http://localhost:3333/api/computer/jobs/job-1/files/file-1', { headers: token === null ? {} : { Authorization: `Bearer ${token}` } }), { params: Promise.resolve({ jobId: 'job-1', fileId: 'file-1' }) });

beforeEach(() => {
  jest.resetAllMocks();
  process.env.BOT_SERVICE_TOKEN = TOKEN;
});
afterAll(() => {
  if (before === undefined) delete process.env.BOT_SERVICE_TOKEN;
  else process.env.BOT_SERVICE_TOKEN = before;
});

describe('GET /api/computer/jobs/:jobId/files/:fileId', () => {
  it('is for the bot server’s token only', async () => {
    expect((await call(null)).status).toBe(401);
    expect((await call('wrong')).status).toBe(401);
    expect(lib.readCard).not.toHaveBeenCalled();
  });

  it('gives the bytes as plain bytes to download, never cached, with the name and type beside them', async () => {
    lib.readCard.mockResolvedValue({ name: 'visa receipt (1).pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4') });
    const response = await call();
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('%PDF-1.4');
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('Content-Length')).toBe('8');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(decodeURIComponent(response.headers.get('X-File-Name') ?? '')).toBe('visa receipt (1).pdf');
    expect(response.headers.get('X-File-Type')).toBe('application/pdf');
    expect(lib.readCard).toHaveBeenCalledWith('job-1', 'file-1');
  });

  it('keeps a name that tries to break a header inside the header', async () => {
    lib.readCard.mockResolvedValue({ name: 'a\r\nSet-Cookie: x=1.pdf', mime: 'application/pdf', data: Buffer.from('x') });
    const response = await call();
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(decodeURIComponent(response.headers.get('X-File-Name') ?? '')).toBe('a\r\nSet-Cookie: x=1.pdf');
  });

  it('says 404 when the file is no longer kept (it reached the chat, the Brick went, or the days passed)', async () => {
    lib.readCard.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });

  it('says 500 and nothing else when it cannot be read', async () => {
    lib.readCard.mockRejectedValue(new Error('boom'));
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});

describe('POST /api/computer/jobs/:jobId/files/:fileId', () => {
  const mark = (token: string | null = TOKEN) =>
    POST(new NextRequest('http://localhost:3333/api/computer/jobs/job-1/files/file-1', { method: 'POST', headers: token === null ? {} : { Authorization: `Bearer ${token}` } }), {
      params: Promise.resolve({ jobId: 'job-1', fileId: 'file-1' }),
    });

  it('is for the bot server’s token only', async () => {
    expect((await mark(null)).status).toBe(401);
    expect((await mark('wrong')).status).toBe(401);
    expect(lib.markFileDelivered).not.toHaveBeenCalled();
  });

  it('keeps that the chat took the file, so a restart never sends it again', async () => {
    lib.markFileDelivered.mockResolvedValue(true);
    const response = await mark();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(lib.markFileDelivered).toHaveBeenCalledWith('job-1', 'file-1');
  });

  it('says 404 for a file that is no longer kept, and 500 and nothing else when it cannot keep the mark', async () => {
    lib.markFileDelivered.mockResolvedValueOnce(false);
    expect((await mark()).status).toBe(404);
    lib.markFileDelivered.mockRejectedValueOnce(new Error('boom'));
    const failed = await mark();
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'Internal server error' });
  });
});
