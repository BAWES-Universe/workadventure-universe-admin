/**
 * GET /api/admin/universes/[id]/roles/[roleId]/used-in: who may read it, and that it answers from computeUsedIn.
 */
import { NextRequest } from 'next/server';

const roleFindFirst = jest.fn();
jest.mock('@/lib/db', () => ({ prisma: { role: { findFirst: (...args: unknown[]) => roleFindFirst(...args) } } }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/roles', () => ({ ensureBuiltInRoles: jest.fn().mockResolvedValue(undefined) }));
const context = jest.fn();
jest.mock('@/lib/universe-route', () => ({
  universeContext: (...args: unknown[]) => context(...args),
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
  context.mockResolvedValue({ ok: true, user: { id: 'viewer', isSuperAdmin: false }, access: {}, universe: { id: 'u' } });
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
  roleFindFirst.mockResolvedValue({ id: 'r', key: 'accountant', permissions: BigInt(256) });
  computeUsedIn.mockResolvedValue({ doors: { basis: 'none', rooms: [], roomsTotal: 0 } });
  const response = await GET(request(), params);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ doors: { basis: 'none', rooms: [], roomsTotal: 0 } });
  expect(computeUsedIn).toHaveBeenCalledWith({
    universeId: 'u',
    role: { id: 'r', key: 'accountant', permissions: BigInt(256) },
    viewer: { id: 'viewer', isSuperAdmin: false },
  });
});

it('answers 500 with a plain error when it cannot be worked out', async () => {
  roleFindFirst.mockResolvedValue({ id: 'r', key: 'accountant', permissions: BigInt(0) });
  computeUsedIn.mockRejectedValue(new Error('db down'));
  const response = await GET(request(), params);
  expect(response.status).toBe(500);
});
