import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { addNotice, clearNotices, countOpenNotices, dismissNotice, openNotices } from '@/lib/notices';

jest.mock('@/lib/db', () => ({ prisma: { userNotice: { create: jest.fn(), findMany: jest.fn(), count: jest.fn(), updateMany: jest.fn() } } }));
const notice = prisma.userNotice as unknown as Record<'create' | 'findMany' | 'count' | 'updateMany', jest.Mock>;

const input = { userId: 'u1', kind: 'ai-key-down', dedupeKey: 'down:key-1:2026-10-19T11:00:00Z', title: 'My LM Studio is down', body: 'Guide and Nora reply on Universe AI.', badge: 'Down', href: '/admin/you/ai-keys' };
const duplicate = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

beforeEach(() => jest.resetAllMocks());

describe('addNotice', () => {
  it('adds a notice and says it is new', async () => {
    notice.create.mockResolvedValue({});
    expect(await addNotice(input)).toBe(true);
    expect(notice.create.mock.calls[0][0].data).toEqual(input);
  });

  it('adds the same thing for the same person only once: a second try is a quiet false', async () => {
    notice.create.mockRejectedValue(duplicate());
    expect(await addNotice(input)).toBe(false);
  });

  it('lets every other error through, so a failure is never taken for "already told"', async () => {
    notice.create.mockRejectedValue(new Error('connection lost'));
    await expect(addNotice(input)).rejects.toThrow('connection lost');
  });

  it('keeps a long title and body inside their columns', async () => {
    notice.create.mockResolvedValue({});
    await addNotice({ ...input, title: 'a'.repeat(300), body: 'b'.repeat(2000), badge: undefined, href: undefined });
    const data = notice.create.mock.calls[0][0].data;
    expect([data.title.length, data.body.length, data.badge, data.href]).toEqual([200, 1000, null, null]);
  });
});

describe('reading and dismissing', () => {
  it('lists only this person’s open notices, newest first', async () => {
    notice.findMany.mockResolvedValue([]);
    await openNotices('u1');
    expect(notice.findMany).toHaveBeenCalledWith({ where: { userId: 'u1', dismissedAt: null }, orderBy: { createdAt: 'desc' }, take: 20 });
    notice.count.mockResolvedValue(3);
    expect(await countOpenNotices('u1')).toBe(3);
    expect(notice.count).toHaveBeenCalledWith({ where: { userId: 'u1', dismissedAt: null } });
  });

  it('dismisses only their own, and says no for someone else’s or one already gone', async () => {
    notice.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await dismissNotice('u1', 'n1')).toBe(true);
    expect(await dismissNotice('u2', 'n1')).toBe(false);
    expect(notice.updateMany.mock.calls[0][0].where).toEqual({ id: 'n1', userId: 'u1', dismissedAt: null });
  });

  it('clears the notices of one kind that stopped being true, for one person', async () => {
    notice.updateMany.mockResolvedValue({ count: 1 });
    await clearNotices('u1', 'ai-key-down', 'down:key-1:');
    expect(notice.updateMany.mock.calls[0][0].where).toEqual({ userId: 'u1', kind: 'ai-key-down', dedupeKey: { startsWith: 'down:key-1:' }, dismissedAt: null });
  });
});

describe('migration: a new table and nothing else', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261019150000_user_notices/migration.sql'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

  it('only creates user_notices, its indexes and its foreign key to users', () => {
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|DROP|INSERT)\b/im);
    expect(sql).not.toMatch(/ALTER TABLE "(?!user_notices")/);
    expect(sql).toMatch(/UNIQUE INDEX "user_notices_user_id_dedupe_key_key"/);
  });
});
