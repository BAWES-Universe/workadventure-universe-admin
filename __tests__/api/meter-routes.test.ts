/**
 * The meter's service route and its settings route (game #1998, Brick 7): who may write, what is worked out here and never taken
 * from the request, and one answer for each event.
 */
import { NextRequest } from 'next/server';
import { POST as writeEvents } from '@/app/api/meter/events/route';
import { GET as getSettings, PATCH as patchSettings } from '@/app/api/admin/meter-settings/route';
import { recordMeterEvent, describeBot, saveMeterSettings, getMeterSettings } from '@/lib/meter';
import { resolveUsagePerson } from '@/lib/usage-person';
import { requireServiceToken } from '@/lib/service-tokens';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/usage-person', () => ({ resolveUsagePerson: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn() }));
jest.mock('@/lib/meter', () => ({
  recordMeterEvent: jest.fn(),
  describeBot: jest.fn(),
  getMeterSettings: jest.fn(),
  saveMeterSettings: jest.fn(),
}));

const record = recordMeterEvent as jest.Mock;
const describe_ = describeBot as jest.Mock;
const resolve = resolveUsagePerson as jest.Mock;
const token = requireServiceToken as jest.Mock;
const session = getSessionUser as jest.Mock;
const admin = isSuperAdmin as jest.Mock;
const save = saveMeterSettings as jest.Mock;
const read = getMeterSettings as jest.Mock;

const post = (body: unknown) => writeEvents(new NextRequest('http://localhost:3333/api/meter/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const event = (over: object = {}) => ({ eventId: 'e1', kind: 'app_use', payerKind: 'universe', basis: 'estimated', quantity: 1, unit: 'use', costMicros: 100, ...over });
const sent = (n = 0) => record.mock.calls[n][0];

beforeEach(() => {
  record.mockReset().mockResolvedValue({ recorded: true, conflict: false });
  describe_.mockReset().mockResolvedValue({ brick: true, ownerId: 'sara' });
  resolve.mockReset().mockResolvedValue({ personId: null, guest: true });
  token.mockReset();
});

describe('POST /api/meter/events', () => {
  it('is for the bot server only', async () => {
    token.mockImplementation(() => {
      throw new Error('Unauthorized: Invalid service token');
    });
    expect((await post(event())).status).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it('records one event and says so', async () => {
    resolve.mockResolvedValue({ personId: 'sara', guest: false });
    const response = await post(event({ botId: 'b1', userId: 'wa-sara', isGuest: false }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [{ eventId: 'e1', status: 'recorded' }] });
  });

  it('works out the person, the account and whether it was a Brick itself, and never takes them from the request', async () => {
    resolve.mockResolvedValue({ personId: 'sara', guest: false });
    await post(event({ botId: 'b1', userId: 'wa-sara', isGuest: false, personKey: 'person:someone-else', personId: 'someone-else', brick: false }));
    expect(sent()).toMatchObject({ personKey: 'person:sara', personId: 'sara', botId: 'b1', brick: true });
  });

  it('counts a guest by their own id and never names them', async () => {
    await post(event({ botId: 'b1', userId: 'wa-guest', isGuest: true }));
    expect(sent()).toMatchObject({ personKey: 'guest:wa-guest', personId: null });
  });

  it('gives work a Brick does with nobody talking to it to its owner, and a room bot’s to nobody', async () => {
    await post(event({ botId: 'b1' }));
    expect(sent()).toMatchObject({ personKey: 'person:sara', personId: 'sara', brick: true });
    describe_.mockResolvedValue({ brick: false, ownerId: null });
    await post(event({ eventId: 'e2', botId: 'room-bot' }));
    expect(sent(1)).toMatchObject({ personKey: 'unknown', brick: false });
  });

  it('answers a bot that does not exist, and writes nothing for it', async () => {
    describe_.mockResolvedValue(null);
    expect(await (await post(event({ botId: 'gone' }))).json()).toEqual({ results: [{ eventId: 'e1', status: 'unknown_bot', error: 'Bot not found' }] });
    expect(record).not.toHaveBeenCalled();
  });

  it('answers a duplicate and a conflict as what they are', async () => {
    record.mockResolvedValueOnce({ recorded: false, conflict: false }).mockResolvedValueOnce({ recorded: false, conflict: true });
    const body = await (await post({ events: [event({ eventId: 'a' }), event({ eventId: 'b' })] })).json();
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['duplicate', 'conflict']);
  });

  it('answers each event of a batch, so a bad one never hides a good one', async () => {
    const body = await (await post({ events: [event({ eventId: 'ok' }), event({ eventId: 'bad', quantity: -1 }), event({ eventId: 'ok2' })] })).json();
    expect(body.results).toEqual([
      { eventId: 'ok', status: 'recorded' },
      { eventId: 'bad', status: 'invalid', error: 'quantity must be a whole number, 0 or more' },
      { eventId: 'ok2', status: 'recorded' },
    ]);
  });

  it('turns down an empty request, one that is too big and anything that is not JSON', async () => {
    expect((await post({ events: [] })).status).toBe(400);
    expect((await post({ events: Array.from({ length: 101 }, (_, i) => event({ eventId: `e${i}` })) })).status).toBe(400);
    const notJson = await writeEvents(new NextRequest('http://localhost:3333/api/meter/events', { method: 'POST', body: 'nope' }));
    expect(notJson.status).toBe(400);
  });
});

describe('the meter’s settings', () => {
  const patch = (body: unknown) => patchSettings(new NextRequest('http://localhost:3333/api/admin/meter-settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  const get = () => getSettings(new NextRequest('http://localhost:3333/api/admin/meter-settings'));
  const empty = { memberAllowanceMicros: null, poolCeilingMicros: null, reserveMicros: null, storageMicrosPerGbMonth: null, atOnceMember: null, atOnceAll: null, renewMinutes: 10 };

  beforeEach(() => {
    session.mockReset().mockResolvedValue({ id: 'admin-1', email: 'admin@bawes.net' });
    admin.mockReset().mockReturnValue(true);
    read.mockReset().mockResolvedValue(empty);
    save.mockReset().mockImplementation(async (change) => ({ ...empty, ...change }));
  });

  it('are for a super admin only', async () => {
    admin.mockReturnValue(false);
    expect((await get()).status).toBe(403);
    expect((await patch({ renewMinutes: 5 })).status).toBe(403);
    expect(save).not.toHaveBeenCalled();
  });

  it('show what is set and what is still missing before room can be taken', async () => {
    const body = await (await get()).json();
    expect(body.settings).toEqual(empty);
    expect(body.missing).toEqual(['memberAllowanceMicros', 'poolCeilingMicros', 'reserveMicros', 'storageMicrosPerGbMonth', 'atOnceMember', 'atOnceAll']);
    expect(body.ranges.renewMinutes).toEqual({ min: 1, max: 1440 });
  });

  it('save only what a change names, checked, and say what is still missing', async () => {
    const response = await patch({ memberAllowanceMicros: 5_000_000 });
    expect(save).toHaveBeenCalledWith({ memberAllowanceMicros: 5_000_000 }, 'admin-1');
    const body = await response.json();
    expect(body.settings.memberAllowanceMicros).toBe(5_000_000);
    expect(body.missing).not.toContain('memberAllowanceMicros');
  });

  it('turn down a value that is not one, with the line that says why', async () => {
    const response = await patch({ atOnceMember: 0 });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/atOnceMember must be a whole number from 1/);
    expect(save).not.toHaveBeenCalled();
  });
});
