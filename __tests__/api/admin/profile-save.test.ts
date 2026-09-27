import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    $transaction: jest.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
    visitCard: { upsert: jest.fn() },
    user: { update: jest.fn(), findUniqueOrThrow: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ requireSession: jest.fn() }));
jest.mock('@/lib/woka-avatar', () => ({ wokaLayersFor: jest.fn(async () => []) }));

import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-session';
import { PUT } from '@/app/api/admin/profile/route';

const db = prisma as unknown as { visitCard: { upsert: jest.Mock }; user: { update: jest.Mock; findUniqueOrThrow: jest.Mock } };
const put = (body: unknown) =>
  PUT(new NextRequest('http://localhost:3333/api/admin/profile', { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }));

beforeEach(() => {
  jest.clearAllMocks();
  (requireSession as jest.Mock).mockResolvedValue({ id: 'me' });
  db.visitCard.upsert.mockResolvedValue({ bio: 'Hello', links: [] });
});

describe('PUT /api/admin/profile', () => {
  it('saves the bio alone without an empty user update, and still answers with your name', async () => {
    db.user.findUniqueOrThrow.mockResolvedValue({ name: 'Khalid' });
    const response = await put({ bio: 'Hello' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'Khalid', bio: 'Hello', links: [] });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('updates the name when one is sent', async () => {
    db.user.update.mockResolvedValue({ name: 'Sara' });
    const response = await put({ name: 'Sara', bio: 'Hello' });
    expect((await response.json()).name).toBe('Sara');
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: 'me' }, data: { name: 'Sara' }, select: { name: true } });
    expect(db.user.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});
