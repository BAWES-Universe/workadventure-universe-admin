/**
 * GET /api/admin/universes/[id]/roles/[roleId]/used-in: who may read it, and that it answers from computeUsedIn.
 */
import { NextRequest } from 'next/server';

const roleFindFirst = jest.fn();
const heldCount = jest.fn();
jest.mock('@/lib/db', () => ({
  prisma: {
    role: { findFirst: (...args: unknown[]) => roleFindFirst(...args) },
    universeMemberRole: { count: (...args: unknown[]) => heldCount(...args) },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/roles', () => ({ ensureBuiltInRoles: jest.fn().mockResolvedValue(undefined) }));
const context = jest.fn();
const seesHidden = jest.fn();
jest.mock('@/lib/universe-route', () => ({
  universeContext: (...args: unknown[]) => context(...args),
  seesHiddenRoles: (...args: unknown[]) => seesHidden(...args),
  failed: (error: unknown) => {
    const { NextResponse } = jest.requireActual('next/server');
    return NextResponse.json({ error: String(error) }, { status: 500 });
  },
}));
const computeUsedIn = jest.fn();
jest.mock('@/lib/role-used-in', () => ({ computeUsedIn: (...args: unknown[]) => computeUsedIn(...args) }));

import { NextResponse } from 'next/server';
import { GET } from '@/app/api/admin/universes/[id]/roles/[roleId]/used-in/route';

const request = () => new NextRequest('http://localhost/api/admin/universes/u/roles/r/used-in');
const params = { params: Promise.resolve({ id: 'u', roleId: 'r' }) };

beforeEach(() => {
  jest.clearAllMocks();
  context.mockResolvedValue({ ok: true, user: { id: 'viewer', isSuperAdmin: false }, access: { who: 'viewer' }, universe: { id: 'u' } });
  seesHidden.mockReturnValue(false);
  heldCount.mockResolvedValue(1);
});

it('answers 404 for a hidden role to someone who neither handles roles nor holds it, as the Roles list hides it', async () => {
  roleFindFirst.mockResolvedValue({ id: 'r', key: 'accountant', permissions: BigInt(256), showBadge: false });
  heldCount.mockResolvedValue(0);
  const response = await GET(request(), params);
  expect(response.status).toBe(404);
  expect(heldCount).toHaveBeenCalledWith({ where: { roleId: 'r', member: { universeId: 'u', userId: 'viewer' } } });
  expect(computeUsedIn).not.toHaveBeenCalled();
});

it('answers for a hidden role to someone who handles roles, without asking who holds it', async () => {
  roleFindFirst.mockResolvedValue({ id: 'r', key: 'accountant', permissions: BigInt(256), showBadge: false });
  seesHidden.mockReturnValue(true);
  heldCount.mockResolvedValue(0);
  computeUsedIn.mockResolvedValue({});
  expect((await GET(request(), params)).status).toBe(200);
  expect(heldCount).not.toHaveBeenCalled();
});

it('is refused, as the other universe routes are, when the universe is not yours to see', async () => {
  context.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Universe not found' }, { status: 404 }) });
  const response = await GET(request(), params);
  expect(response.status).toBe(404);
  expect(computeUsedIn).not.toHaveBeenCalled();
});

it('answers 404 for a role of another universe', async () => {
  roleFindFirst.mockResolvedValue(null);
  const response = await GET(request(), params);
  expect(response.status).toBe(404);
  expect(roleFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'r', universeId: 'u' } }));
});

it('computes where the role is used for the person asking', async () => {
  roleFindFirst.mockResolvedValue({ id: 'r', key: 'accountant', permissions: BigInt(256), showBadge: false });
  computeUsedIn.mockResolvedValue({ doors: { basis: 'none', rooms: [], roomsTotal: 0 } });
  const response = await GET(request(), params);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ doors: { basis: 'none', rooms: [], roomsTotal: 0 } });
  expect(computeUsedIn).toHaveBeenCalledWith({
    universeId: 'u',
    role: { id: 'r', key: 'accountant', permissions: BigInt(256), showBadge: false },
    viewer: { id: 'viewer', isSuperAdmin: false },
    seesHidden: false,
  });
});

it('tells the computation whether the viewer gives or manages roles, so a hidden role stays hidden from the rest', async () => {
  seesHidden.mockReturnValue(true);
  roleFindFirst.mockResolvedValue({ id: 'r', key: 'accountant', permissions: BigInt(0), showBadge: false });
  computeUsedIn.mockResolvedValue({});
  await GET(request(), params);
  expect(seesHidden).toHaveBeenCalledWith({ who: 'viewer' });
  expect(computeUsedIn).toHaveBeenCalledWith(expect.objectContaining({ seesHidden: true }));
});

it('answers 500 with a plain error when it cannot be worked out', async () => {
  roleFindFirst.mockResolvedValue({ id: 'r', key: 'accountant', permissions: BigInt(0) });
  computeUsedIn.mockRejectedValue(new Error('db down'));
  const response = await GET(request(), params);
  expect(response.status).toBe(500);
});
