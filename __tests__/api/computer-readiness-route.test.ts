/** The team's readiness check: super admins only, and what it says comes from the provider and the controls. */
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/admin/computer/readiness/route';
import { computerReadiness } from '@/lib/computer-readiness';
import { getSessionUser } from '@/lib/auth-session';
import { getComputerProvider, type ComputerProvider } from '@/lib/computer-provider';
import { getMeterSettings } from '@/lib/meter';
import { isWindingDown } from '@/lib/computer';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/computer-provider', () => ({ getComputerProvider: jest.fn() }));
jest.mock('@/lib/meter', () => ({ getMeterSettings: jest.fn() }));
jest.mock('@/lib/computer', () => ({ isWindingDown: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const session = getSessionUser as jest.Mock;
const provider = getComputerProvider as jest.Mock;
const settings = getMeterSettings as jest.Mock;
const winding = isWindingDown as jest.Mock;
const before = process.env.SUPER_ADMINS;
const FULL = { memberAllowanceMicros: 1, poolCeilingMicros: 1, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 1, atOnceAll: 1, renewMinutes: 10 };
const real = (checks: Array<{ name: string; ok: boolean; detail: string }>) => ({ kind: 'real', checkup: async () => checks }) as unknown as ComputerProvider;

beforeEach(() => {
  jest.resetAllMocks();
  process.env.SUPER_ADMINS = 'team@example.test';
  session.mockResolvedValue({ id: 'u1', email: 'team@example.test' });
  settings.mockResolvedValue(FULL);
  winding.mockResolvedValue(false);
});
afterAll(() => {
  if (before === undefined) delete process.env.SUPER_ADMINS;
  else process.env.SUPER_ADMINS = before;
});

describe('the readiness check', () => {
  it('is for super admins only', async () => {
    for (const user of [null, { id: 'u2', email: 'sara@example.test' }]) {
      session.mockResolvedValue(user);
      expect((await GET(new NextRequest('http://localhost:3333/api/admin/computer/readiness'))).status).toBe(403);
    }
  });

  it('is ready when the provider, the controls and the door all say so', async () => {
    provider.mockReturnValue(real([{ name: 'agent37 key', ok: true, detail: 'The Agent37 key works' }]));
    const answer = await computerReadiness();
    expect(answer.ready).toBe(true);
    expect(answer.checks.map((check) => check.name)).toEqual(['provider', 'agent37 key', 'usage controls', 'wind-down']);
  });

  it('is not ready, and says why, without a provider, with a check that failed, with controls not set, or during a wind-down', async () => {
    provider.mockReturnValue(null);
    expect((await computerReadiness()).checks[0]).toMatchObject({ name: 'provider', ok: false });
    provider.mockReturnValue(real([{ name: 'computer image', ok: false, detail: 'The computer image is being built' }]));
    expect((await computerReadiness()).ready).toBe(false);
    provider.mockReturnValue(real([]));
    settings.mockResolvedValue({ ...FULL, reserveMicros: null });
    expect((await computerReadiness()).checks.find((check) => check.name === 'usage controls')).toMatchObject({ ok: false });
    settings.mockResolvedValue(FULL);
    winding.mockResolvedValue(true);
    expect((await computerReadiness()).checks.find((check) => check.name === 'wind-down')).toMatchObject({ ok: false });
  });

  it('answers a failed provider check as a failed check, not an error', async () => {
    provider.mockReturnValue({ kind: 'real', checkup: async () => { throw new Error('boom'); } } as unknown as ComputerProvider);
    const answer = await computerReadiness();
    expect(answer.ready).toBe(false);
    expect(answer.checks.some((check) => check.detail === 'The provider could not be checked')).toBe(true);
  });
});
