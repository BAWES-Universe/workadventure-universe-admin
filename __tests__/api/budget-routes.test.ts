/**
 * The Budget page's routes: every one is a super admin's (a person who is not gets 403 on read and on save), a number outside its range is refused
 * with a plain line and nothing is saved, and "in effect" is only what the backend read back.
 */
import { NextRequest } from 'next/server';
import { GET as getBudget } from '@/app/api/admin/budget/route';
import { PUT as putNumber } from '@/app/api/admin/budget/numbers/route';
import { GET as getChanges } from '@/app/api/admin/budget/changes/route';
import { POST as verifyAccount } from '@/app/api/admin/budget/accounts/[key]/verify/route';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { buildReport } from '@/lib/budget/report';
import { saveNumber } from '@/lib/budget/numbers';
import { lookAgain } from '@/lib/budget/verify';
import { listChanges } from '@/lib/budget/history';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn() }));
jest.mock('@/lib/budget/report', () => ({ buildReport: jest.fn() }));
jest.mock('@/lib/budget/verify', () => ({ lookAgain: jest.fn() }));
jest.mock('@/lib/budget/history', () => ({ listChanges: jest.fn(), lastChanges: jest.fn() }));
jest.mock('@/lib/budget/warnings', () => ({ clearBudgetNotices: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/budget/numbers', () => ({
  ...jest.requireActual('@/lib/budget/numbers'),
  saveNumber: jest.fn(),
}));
jest.mock('@/lib/db', () => ({ prisma: { user: { findMany: jest.fn().mockResolvedValue([]) } } }));

const session = getSessionUser as jest.Mock;
const admin = isSuperAdmin as jest.Mock;
const report = buildReport as jest.Mock;
const save = saveNumber as jest.Mock;
const look = lookAgain as jest.Mock;
const changes = listChanges as jest.Mock;

const put = (body: unknown) => putNumber(new NextRequest('http://localhost:3333/api/admin/budget/numbers', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const verify = (key: string) => verifyAccount(new NextRequest(`http://localhost:3333/api/admin/budget/accounts/${key}/verify`, { method: 'POST' }), { params: Promise.resolve({ key }) });
const ask = (url: string) => new NextRequest(`http://localhost:3333${url}`);

const asSuperAdmin = () => {
  session.mockResolvedValue({ id: 'khalid', email: 'khalid@example.test' });
  admin.mockReturnValue(true);
};
const asMember = () => {
  session.mockResolvedValue({ id: 'sara', email: 'sara@example.test' });
  admin.mockReturnValue(false);
};

beforeEach(() => {
  session.mockReset();
  admin.mockReset();
  report.mockReset().mockResolvedValue({ areas: [] });
  save.mockReset();
  look.mockReset();
  changes.mockReset().mockResolvedValue([]);
});

describe('who may read and save', () => {
  it('turns a member away from every route with 403, and touches nothing', async () => {
    asMember();
    expect((await getBudget(ask('/api/admin/budget'))).status).toBe(403);
    expect((await put({ id: 'meter:poolCeilingMicros', value: 5_000_000 })).status).toBe(403);
    expect((await getChanges(ask('/api/admin/budget/changes'))).status).toBe(403);
    expect((await verify('agent37')).status).toBe(403);
    expect(report).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
    expect(look).not.toHaveBeenCalled();
  });

  it('turns away someone who is not signed in', async () => {
    session.mockResolvedValue(null);
    expect((await getBudget(ask('/api/admin/budget'))).status).toBe(403);
    expect((await put({ id: 'meter:poolCeilingMicros', value: 5_000_000 })).status).toBe(403);
  });

  it('lets a super admin read the page', async () => {
    asSuperAdmin();
    const response = await getBudget(ask('/api/admin/budget'));
    expect(response.status).toBe(200);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ userId: 'khalid', notify: true }));
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('saving a number', () => {
  it('saves for the super admin who asked and says it is in effect only when the backend read it back', async () => {
    asSuperAdmin();
    save.mockResolvedValue({ ok: true, value: 90_000_000, inEffect: true });
    const response = await put({ id: 'meter:poolCeilingMicros', value: 90_000_000 });
    expect(save).toHaveBeenCalledWith('meter:poolCeilingMicros', 90_000_000, 'khalid');
    expect(await response.json()).toEqual({ id: 'meter:poolCeilingMicros', value: 90_000_000, inEffect: true });
    save.mockResolvedValue({ ok: true, value: 80_000_000, inEffect: false });
    expect(await (await put({ id: 'meter:poolCeilingMicros', value: 90_000_000 })).json()).toMatchObject({ inEffect: false });
  });

  it('refuses a value outside its range with the plain line from the store and saves nothing more', async () => {
    asSuperAdmin();
    save.mockResolvedValue({ ok: false, status: 400, error: 'Computers budget must be a whole number from 1 to 1,000,000,000,000,000' });
    const response = await put({ id: 'meter:poolCeilingMicros', value: -5 });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('from 1 to');
  });

  it('refuses a number the page does not know with 404', async () => {
    asSuperAdmin();
    save.mockResolvedValue({ ok: false, status: 404, error: 'That number is not on this page' });
    expect((await put({ id: 'meter:nothing', value: 1 })).status).toBe(404);
  });

  it('refuses a body that is not an id and a whole number', async () => {
    asSuperAdmin();
    expect((await put({ id: 'meter:poolCeilingMicros', value: 1.5 })).status).toBe(400);
    expect((await put({ value: 1 })).status).toBe(400);
    expect((await put({ id: 'meter:poolCeilingMicros', value: 1, extra: true })).status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('the history', () => {
  it('lists the newest first for a super admin and refuses a take that is not sensible', async () => {
    asSuperAdmin();
    changes.mockResolvedValue([{ id: 'c1', store: 'meter', key: 'poolCeilingMicros', oldValue: 2_000_000, newValue: 90_000_000, changedById: null, changedAt: '2031-06-15T12:00:00.000Z', note: null }]);
    const body = await (await getChanges(ask('/api/admin/budget/changes'))).json();
    expect(body.changes[0]).toMatchObject({ numberId: 'meter:poolCeilingMicros', label: 'Computers budget', oldValue: 2_000_000, newValue: 90_000_000, by: 'Orbit' });
    expect((await getChanges(ask('/api/admin/budget/changes?take=0'))).status).toBe(400);
    expect((await getChanges(ask('/api/admin/budget/changes?number=nothing'))).status).toBe(404);
  });
});

describe('checking a company again after a top up', () => {
  it('reads that company and asks the backend to look again, and says what it did', async () => {
    asSuperAdmin();
    report.mockResolvedValue({ accounts: [{ key: 'agent37', name: 'Agent37', state: 'ok' }] });
    look.mockResolvedValue({ looked: true, line: 'Orbit carried on with 4 waiting jobs, once each.', computersStarted: 4 });
    const response = await verify('agent37');
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ onlyCompany: 'agent37' }));
    expect(look).toHaveBeenCalledWith('agent37', expect.objectContaining({ key: 'agent37' }), 'khalid');
    expect((await response.json()).looked.computersStarted).toBe(4);
  });

  it('knows only the companies on the page', async () => {
    asSuperAdmin();
    expect((await verify('nobody')).status).toBe(404);
  });
});
