/** The owner's side of a computer result in Files: who may open or delete it, and that it only ever comes as plain bytes to download. */
import { NextRequest } from 'next/server';
import { GET, DELETE } from '@/app/api/bricks/[id]/files/results/[fileId]/route';
import { GET as listOwn } from '@/app/api/bricks/results/route';
import { GET as openOwn, DELETE as deleteOwn } from '@/app/api/bricks/results/[fileId]/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import * as cards from '@/lib/computer-file-cards';

jest.mock('@/lib/db', () => ({ prisma: { user: { findUnique: jest.fn() }, bot: { findUnique: jest.fn() } } }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/computer-file-cards');
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const db = prisma as unknown as { user: { findUnique: jest.Mock }; bot: { findUnique: jest.Mock } };
const lib = cards as jest.Mocked<typeof cards>;
const params = { params: Promise.resolve({ id: 'brick-1', fileId: 'file-1' }) };
const req = (method: 'GET' | 'DELETE') => new NextRequest('http://localhost:3333/api/bricks/brick-1/files/results/file-1', { method });

beforeEach(() => {
  jest.resetAllMocks();
  (getSessionUser as jest.Mock).mockResolvedValue({ id: 'u-sara' });
  db.user.findUnique.mockResolvedValue({ isGuest: false });
  db.bot.findUnique.mockResolvedValue({ id: 'brick-1', roomId: null, ownerId: 'u-sara', deletedAt: null });
});

describe('opening a result', () => {
  it('gives the owner the bytes as a download, never as a page, never cached', async () => {
    lib.readResult.mockResolvedValue({ name: 'visa receipt.pdf', mime: 'application/pdf', data: Buffer.from('%PDF') });
    const response = await GET(req('GET'), params);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('%PDF');
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('Content-Disposition')).toContain('attachment');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(lib.readResult).toHaveBeenCalledWith('brick-1', 'u-sara', 'file-1');
  });

  it('says nothing is there for someone who is not signed in, a guest, someone else’s Brick, or a file that is gone', async () => {
    (getSessionUser as jest.Mock).mockResolvedValueOnce(null);
    expect((await GET(req('GET'), params)).status).toBe(401);
    db.user.findUnique.mockResolvedValueOnce({ isGuest: true });
    expect((await GET(req('GET'), params)).status).toBe(403);
    db.bot.findUnique.mockResolvedValueOnce({ id: 'brick-1', roomId: null, ownerId: 'u-other', deletedAt: null });
    expect((await GET(req('GET'), params)).status).toBe(404);
    lib.readResult.mockResolvedValueOnce(null);
    expect((await GET(req('GET'), params)).status).toBe(404);
    expect(lib.readResult).toHaveBeenCalledTimes(1);
  });
});

describe('deleting a result', () => {
  it('lets the owner delete it, and says 404 for someone else’s Brick or a file that is gone', async () => {
    lib.deleteResult.mockResolvedValueOnce(true);
    const response = await DELETE(req('DELETE'), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(lib.deleteResult).toHaveBeenCalledWith('brick-1', 'u-sara', 'file-1');
    lib.deleteResult.mockResolvedValueOnce(false);
    expect((await DELETE(req('DELETE'), params)).status).toBe(404);
    db.bot.findUnique.mockResolvedValueOnce({ id: 'brick-1', roomId: null, ownerId: 'u-other', deletedAt: null });
    expect((await DELETE(req('DELETE'), params)).status).toBe(404);
    expect(lib.deleteResult).toHaveBeenCalledTimes(2);
  });
});

describe('results whose Brick is gone (the person’s own, whichever Brick made them)', () => {
  const ownParams = { params: Promise.resolve({ fileId: 'file-1' }) };
  const ownReq = (method: 'GET' | 'DELETE', path = 'file-1') => new NextRequest(`http://localhost:3333/api/bricks/results/${path}`, { method });

  it('lists them with "A deleted Brick" on them, for the signed-in person only', async () => {
    lib.orphanResultsOf.mockResolvedValue([
      { id: 'r1', jobId: null, name: 'visa.pdf', bytes: 5000, mime: 'application/pdf', jobTitle: 'Visa form', brick: 'A deleted Brick', brickId: 'brick-9', at: new Date('2026-11-12T08:00:00Z'), delivery: 'not_delivered' },
    ]);
    const response = await listOwn(new NextRequest('http://localhost:3333/api/bricks/results'));
    expect(await response.json()).toEqual({ results: [{ id: 'r1', name: 'visa.pdf', sizeBytes: 5000, job: 'Visa form', brick: 'A deleted Brick', at: '2026-11-12T08:00:00.000Z', delivery: 'not_delivered' }] });
    expect(lib.orphanResultsOf).toHaveBeenCalledWith('u-sara');
    (getSessionUser as jest.Mock).mockResolvedValueOnce(null);
    expect((await listOwn(new NextRequest('http://localhost:3333/api/bricks/results'))).status).toBe(401);
    db.user.findUnique.mockResolvedValueOnce({ isGuest: true });
    expect((await listOwn(new NextRequest('http://localhost:3333/api/bricks/results'))).status).toBe(403);
  });

  it('opens one as a download for its owner, and says nothing is there for anyone else', async () => {
    lib.readOwnResult.mockResolvedValueOnce({ name: 'visa.pdf', mime: 'application/pdf', data: Buffer.from('%PDF') });
    const response = await openOwn(ownReq('GET'), ownParams);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('Content-Disposition')).toContain('attachment');
    expect(lib.readOwnResult).toHaveBeenCalledWith('u-sara', 'file-1');
    lib.readOwnResult.mockResolvedValueOnce(null);
    expect((await openOwn(ownReq('GET'), ownParams)).status).toBe(404);
  });

  it('deletes one for its owner only', async () => {
    lib.deleteOwnResult.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await deleteOwn(ownReq('DELETE'), ownParams)).status).toBe(200);
    expect(lib.deleteOwnResult).toHaveBeenCalledWith('u-sara', 'file-1');
    expect((await deleteOwn(ownReq('DELETE'), ownParams)).status).toBe(404);
  });
});
