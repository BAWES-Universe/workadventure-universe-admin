import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/me/nearby-shared/route';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';

type Row = Record<string, unknown> & { id: string; userId: string; itemKey: string; sentAt: Date };
const rows: Row[] = [];
let nextId = 0;

type Clause = Record<string, unknown> & { OR?: Clause[]; AND?: Clause[] };
type Where = Clause & { userId: string };

// Enough of Prisma's where for this route: equality, lt, has, and nested AND / OR.
function matches(row: Row, where: Clause): boolean {
  return Object.entries(where).every(([field, condition]) => {
    if (field === 'AND') return (condition as Clause[]).every((clause) => matches(row, clause));
    if (field === 'OR') return (condition as Clause[]).some((clause) => matches(row, clause));
    const value = row[field];
    if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
    if (condition !== null && typeof condition === 'object') {
      const test = condition as { lt?: Date | string; has?: string };
      if ('lt' in test) return value !== undefined && value !== null && (value as Date | string) < (test.lt as Date | string);
      if ('has' in test) return Array.isArray(value) && value.includes(test.has);
    }
    return (value ?? null) === condition;
  });
}

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/db', () => ({
  prisma: {
    nearbySharedItem: {
      findMany: jest.fn(async ({ where, take }: { where: Where; take: number }) =>
        rows
          .filter((row) => matches(row, where))
          .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime() || (a.id < b.id ? 1 : -1))
          .slice(0, take)),
      createMany: jest.fn(async ({ data }: { data: Array<Record<string, unknown> & { userId: string; itemKey: string; sentAt: Date }> }) => {
        let count = 0;
        for (const item of data) {
          if (rows.some((row) => row.userId === item.userId && row.itemKey === item.itemKey)) continue;
          nextId += 1;
          rows.push({ ...item, id: String(nextId).padStart(4, '0') });
          count += 1;
        }
        return { count };
      }),
    },
  },
}));

const BASE = 'http://localhost:3333/api/me/nearby-shared';
const alice = { id: 'user-a', uuid: 'uuid-a', email: 'a@example.com', name: 'A', tags: [], isSuperAdmin: false };
const bob = { ...alice, id: 'user-b', uuid: 'uuid-b' };

const link = (key: string, sentAt: string) => ({
  itemKey: key,
  kind: 'link',
  name: `https://bawes.net/${key}`,
  link: `https://bawes.net/${key}`,
  senderName: 'Sara',
  sentAt,
});

function post(body: unknown) {
  return POST(new NextRequest(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

function get(query = '') {
  return GET(new NextRequest(`${BASE}${query}`));
}

describe('/api/me/nearby-shared', () => {
  beforeEach(() => {
    rows.length = 0;
    nextId = 0;
    jest.clearAllMocks();
    (getSessionUser as jest.Mock).mockResolvedValue(alice);
  });

  it('keeps nothing and shows nothing for a guest', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect((await post({ items: [link('a', '2026-10-26T09:00:00.000Z')] })).status).toBe(401);
    expect(prisma.nearbySharedItem.createMany).not.toHaveBeenCalled();
  });

  it('lists what was kept, newest first, once per item', async () => {
    const saved = await post({ items: [link('a', '2026-10-26T09:00:00.000Z'), link('b', '2026-10-26T09:05:00.000Z')] });
    expect(await saved.json()).toEqual({ saved: 2, skipped: 0 });
    const again = await post({ items: [link('a', '2026-10-26T09:00:00.000Z')] });
    expect(await again.json()).toEqual({ saved: 0, skipped: 0 });

    const response = await get();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.map((item: { itemKey: string }) => item.itemKey)).toEqual(['b', 'a']);
    expect(body.items[0]).toEqual(expect.objectContaining({ kind: 'link', sentAt: '2026-10-26T09:05:00.000Z' }));
    expect(body.items[0]).not.toHaveProperty('id');
    expect(body.next).toBeNull();
  });

  it("keeps each person's list to themselves", async () => {
    await post({ items: [link('a', '2026-10-26T09:00:00.000Z')] });
    (getSessionUser as jest.Mock).mockResolvedValue(bob);
    expect((await (await get()).json()).items).toEqual([]);
  });

  it('pages through the list without skipping items sent at the same moment', async () => {
    const same = '2026-10-26T09:00:00.000Z';
    await post({ items: [link('a', same), link('b', same), link('c', same), link('d', '2026-10-26T08:00:00.000Z')] });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const body: { items: Array<{ itemKey: string }>; next: string | null } = await (await get(query)).json();
      seen.push(...body.items.map((item) => item.itemKey));
      cursor = body.next;
    } while (cursor);

    expect(seen).toHaveLength(4);
    expect(new Set(seen)).toEqual(new Set(['a', 'b', 'c', 'd']));
    expect(seen[3]).toBe('d');
  });

  it('turns down a bad page request', async () => {
    expect((await get('?limit=0')).status).toBe(400);
    expect((await get('?limit=101')).status).toBe(400);
    expect((await get('?cursor=nonsense')).status).toBe(400);
  });

  it('leaves out items that do not check out, and counts them', async () => {
    const response = await post({ items: [link('a', '2026-10-26T09:00:00.000Z'), { itemKey: 'x', kind: 'voice' }] });
    expect(await response.json()).toEqual({ saved: 1, skipped: 1 });
  });

  it('turns down a body without items, and too many at once', async () => {
    expect((await post('nope')).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ items: [] })).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, index) => link(String(index), '2026-10-26T09:00:00.000Z'));
    expect((await post({ items: many })).status).toBe(413);
  });

  describe('one person (game #1615)', () => {
    const GITHUB = '@bot_12:chat.bawes.net';
    const SARA = '@sara:chat.bawes.net';
    const item = (key: string, extra: Record<string, unknown>) => ({ ...link(key, '2026-10-29T20:19:00.000Z'), ...extra });

    it('lists what they sent and what you sent while they were there, nothing else', async () => {
      await post({
        items: [
          item('mine-with-github', { mine: true, senderName: 'Khalid', withChatIds: [GITHUB, SARA] }),
          item('from-github', { senderName: 'GitHub [StudentHub]', senderChatId: GITHUB, withChatIds: [SARA] }),
          item('from-sara', { senderName: 'Sara', senderChatId: SARA, withChatIds: [GITHUB] }),
          item('mine-with-sara', { mine: true, senderName: 'Khalid', withChatIds: [SARA] }),
        ],
      });
      const body = await (await get(`?with=${encodeURIComponent(GITHUB)}`)).json();
      expect(body.items.map((one: { itemKey: string }) => one.itemKey).sort()).toEqual(['from-github', 'mine-with-github']);
      expect(body.items.find((one: { itemKey: string }) => one.itemKey === 'from-github').senderChatId).toBe(GITHUB);
    });

    it('finds what they sent before items named a chat account by their name, only when asked', async () => {
      await post({ items: [item('old', { senderName: 'GitHub [StudentHub]' }), item('old-mine', { mine: true, senderName: 'GitHub [StudentHub]' })] });
      const without = await (await get(`?with=${encodeURIComponent(GITHUB)}`)).json();
      expect(without.items).toEqual([]);
      const named = await (await get(`?with=${encodeURIComponent(GITHUB)}&name=${encodeURIComponent('GitHub [StudentHub]')}`)).json();
      expect(named.items.map((one: { itemKey: string }) => one.itemKey)).toEqual(['old']);
    });

    it('turns down a bad person request', async () => {
      expect((await get('?with=')).status).toBe(400);
      expect((await get('?name=Sara')).status).toBe(400);
      expect((await get(`?with=${encodeURIComponent(SARA)}&name=%20`)).status).toBe(400);
    });
  });
});
