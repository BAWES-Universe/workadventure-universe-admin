/**
 * The team's wind-down command: super admins only, and it only asks the library (the work itself is tested against a real database in
 * computer-db.test.ts).
 */
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/admin/computer/wind-down/route';
import { getSessionUser } from '@/lib/auth-session';
import * as computer from '@/lib/computer';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/computer');
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const session = getSessionUser as jest.Mock;
const lib = computer as jest.Mocked<typeof computer>;
const before = process.env.SUPER_ADMINS;
const status = { on: true, since: '2026-11-15T12:00:00.000Z', by: 'team@example.test', jobsLeft: 0, machinesLeft: 0 };

const post = (body: unknown) => new NextRequest('http://localhost:3333/api/admin/computer/wind-down', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = () => new NextRequest('http://localhost:3333/api/admin/computer/wind-down', { method: 'GET' });

beforeEach(() => {
  jest.resetAllMocks();
  process.env.SUPER_ADMINS = 'team@example.test';
  session.mockResolvedValue({ id: 'u1', email: 'team@example.test' });
  lib.startWindDown.mockResolvedValue(status);
  lib.liftWindDown.mockResolvedValue({ ...status, on: false });
  lib.windDownStatus.mockResolvedValue(status);
});
afterAll(() => {
  if (before === undefined) delete process.env.SUPER_ADMINS;
  else process.env.SUPER_ADMINS = before;
});

describe('the wind-down command', () => {
  it('is for super admins only: nobody else, signed in or not, can start it, lift it or read it', async () => {
    for (const user of [null, { id: 'u2', email: 'sara@example.test' }, { id: 'u3', email: null }]) {
      session.mockResolvedValue(user);
      expect((await POST(post({ action: 'start' }))).status).toBe(403);
      expect((await POST(post({ action: 'lift' }))).status).toBe(403);
      expect((await GET(get())).status).toBe(403);
    }
    expect(lib.startWindDown).not.toHaveBeenCalled();
    expect(lib.liftWindDown).not.toHaveBeenCalled();
  });

  it('starts it as the one who asked, and answers where it stands', async () => {
    const response = await POST(post({ action: 'start' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual(status);
    expect(lib.startWindDown).toHaveBeenCalledWith('team@example.test');
  });

  it('lifts it as the one who asked', async () => {
    const response = await POST(post({ action: 'lift' }));
    expect((await response.json()).on).toBe(false);
    expect(lib.liftWindDown).toHaveBeenCalledWith('team@example.test');
  });

  it('refuses anything else it is told, without starting a thing', async () => {
    expect((await POST(post({ action: 'pause' }))).status).toBe(400);
    expect((await POST(post('not json'))).status).toBe(400);
    expect((await POST(post({}))).status).toBe(400);
    expect(lib.startWindDown).not.toHaveBeenCalled();
  });

  it('reads where it stands', async () => {
    expect(await (await GET(get())).json()).toEqual(status);
  });
});
