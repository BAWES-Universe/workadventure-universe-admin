/**
 * /api/bots/:id/permissions and /rules (#427): who may read and change a bot's rules, and that every refusal says why.
 */
import { NextRequest } from 'next/server';
import { GET, PUT } from '@/app/api/bots/[id]/permissions/route';
import { PUT as PUT_RULE, DELETE as DELETE_RULE } from '@/app/api/bots/[id]/permissions/rules/route';
import { getSessionUser } from '@/lib/auth-session';
import { canManageThisBot } from '@/lib/bot-permissions';
import * as settings from '@/lib/bot-access-settings';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/bot-permissions', () => ({ canManageThisBot: jest.fn() }));
jest.mock('@/lib/bot-access-settings', () => ({
  ...jest.requireActual('@/lib/bot-access-settings'),
  loadBotPlace: jest.fn(),
  readBotSettings: jest.fn(),
  saveBotSettings: jest.fn(),
  saveBotRule: jest.fn(),
  deleteBotRule: jest.fn(),
}));

const session = getSessionUser as jest.Mock;
const manages = canManageThisBot as jest.Mock;
const mocked = settings as unknown as Record<'loadBotPlace' | 'readBotSettings' | 'saveBotSettings' | 'saveBotRule' | 'deleteBotRule', jest.Mock>;

const PLACE = { id: 'bot-1', createdById: 'u-maker', roomId: 'room-1', universeId: 'u1', universeOwnerId: 'u-owner' };
const SETTINGS = { privateBot: true, refusalReply: 'Not for you.', dailyReplyCap: 50, rules: [], roles: [] };
const params = { params: Promise.resolve({ id: 'bot-1' }) };

function call(handler: (r: NextRequest, c: typeof params) => Promise<Response>, method: string, body?: unknown, { path = '', token }: { path?: string; token?: string } = {}) {
  return handler(
    new NextRequest(`http://localhost:3333/api/bots/bot-1/permissions${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
    params,
  );
}

beforeEach(() => {
  process.env.ADMIN_API_TOKEN = 'admin-secret';
  session.mockReset().mockResolvedValue({ id: 'u-sara', email: 'sara@example.com' });
  manages.mockReset().mockResolvedValue(true);
  for (const name of ['loadBotPlace', 'readBotSettings', 'saveBotSettings', 'saveBotRule', 'deleteBotRule'] as const) mocked[name].mockReset();
  mocked.loadBotPlace.mockResolvedValue(PLACE);
  mocked.readBotSettings.mockResolvedValue(SETTINGS);
  mocked.saveBotRule.mockResolvedValue({ id: 'rule-1', roleId: 'r-acc', chat: 'yes' });
  mocked.deleteBotRule.mockResolvedValue(true);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('who may reach the rules', () => {
  it('answers 401 to someone who is not signed in, and reads nothing', async () => {
    session.mockResolvedValue(null);
    for (const response of [await call(GET, 'GET'), await call(PUT, 'PUT', { privateBot: true }), await call(PUT_RULE, 'PUT', { roleId: 'r' }, { path: '/rules' }), await call(DELETE_RULE, 'DELETE', undefined, { path: '/rules?roleId=r' })]) {
      expect(response.status).toBe(401);
    }
    expect(mocked.readBotSettings).not.toHaveBeenCalled();
    expect(mocked.saveBotSettings).not.toHaveBeenCalled();
    expect(mocked.saveBotRule).not.toHaveBeenCalled();
  });

  it('answers a stranger as if the bot did not exist, for reading and for every change', async () => {
    manages.mockResolvedValue(false);
    for (const response of [await call(GET, 'GET'), await call(PUT, 'PUT', { privateBot: true }), await call(PUT_RULE, 'PUT', { roleId: 'r' }, { path: '/rules' }), await call(DELETE_RULE, 'DELETE', undefined, { path: '/rules?roleId=r' })]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Bot not found' });
    }
    expect(mocked.saveBotSettings).not.toHaveBeenCalled();
    expect(mocked.saveBotRule).not.toHaveBeenCalled();
    expect(mocked.deleteBotRule).not.toHaveBeenCalled();
  });

  it('asks whether this person manages this bot, letting its creator in', async () => {
    await call(GET, 'GET');
    expect(manages).toHaveBeenCalledWith('u-sara', 'sara@example.com', { id: 'bot-1', createdById: 'u-maker', roomId: 'room-1' }, { creatorPasses: true });
  });

  it('answers 404 for a bot that does not exist', async () => {
    mocked.loadBotPlace.mockResolvedValue(null);
    expect((await call(GET, 'GET')).status).toBe(404);
  });

  it('lets the bot server read with its admin token, never change', async () => {
    session.mockResolvedValue(null);
    expect((await call(GET, 'GET', undefined, { token: 'admin-secret' })).status).toBe(200);
    expect((await call(GET, 'GET', undefined, { token: 'wrong' })).status).toBe(401);
    expect((await call(PUT, 'PUT', { privateBot: true }, { token: 'admin-secret' })).status).toBe(401);
    expect((await call(PUT_RULE, 'PUT', { roleId: 'r' }, { path: '/rules', token: 'admin-secret' })).status).toBe(401);
    expect((await call(DELETE_RULE, 'DELETE', undefined, { path: '/rules?roleId=r', token: 'admin-secret' })).status).toBe(401);
  });

  it('without an admin token configured, no bearer token is accepted', async () => {
    delete process.env.ADMIN_API_TOKEN;
    session.mockResolvedValue(null);
    expect((await call(GET, 'GET', undefined, { token: 'undefined' })).status).toBe(401);
  });
});

describe('reading', () => {
  it('returns the settings, the rows and the roles', async () => {
    const response = await call(GET, 'GET');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SETTINGS);
  });

  it('answers 500, not an empty page, when the database fails, and reports it', async () => {
    mocked.readBotSettings.mockRejectedValue(new Error('down'));
    const response = await call(GET, 'GET');
    expect(response.status).toBe(500);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(require('@sentry/nextjs').captureException).toHaveBeenCalled();
  });
});

describe('saving settings', () => {
  it('saves and returns the new settings', async () => {
    const response = await call(PUT, 'PUT', { privateBot: true, refusalReply: 'Not for you.', dailyReplyCap: 20 });
    expect(response.status).toBe(200);
    expect(mocked.saveBotSettings).toHaveBeenCalledWith('bot-1', { privateBot: true, refusalReply: 'Not for you.', dailyReplyCap: 20 });
    expect(await response.json()).toEqual(SETTINGS);
  });

  it.each([
    ['not JSON', 'not json'],
    ['nothing to change', {}],
    ['a cap of zero', { dailyReplyCap: 0 }],
    ['a cap of 10001', { dailyReplyCap: 10001 }],
    ['a line over 500 characters', { refusalReply: 'x'.repeat(501) }],
    ['a field it does not know', { privateBot: true, enabled: false }],
  ])('answers 400 for %s, and saves nothing', async (_name, body) => {
    expect((await call(PUT, 'PUT', body)).status).toBe(400);
    expect(mocked.saveBotSettings).not.toHaveBeenCalled();
  });

  it('answers 500 when saving fails, never success', async () => {
    mocked.saveBotSettings.mockRejectedValue(new Error('down'));
    expect((await call(PUT, 'PUT', { privateBot: true })).status).toBe(500);
  });
});

describe('saving a rule', () => {
  it('saves a rule for a role or a person and returns the row', async () => {
    const response = await call(PUT_RULE, 'PUT', { roleId: 'r-acc', chat: 'yes', dm: 'no' }, { path: '/rules' });
    expect(response.status).toBe(200);
    expect(mocked.saveBotRule).toHaveBeenCalledWith(PLACE, { roleId: 'r-acc', chat: 'yes', dm: 'no' });
    expect(await response.json()).toMatchObject({ id: 'rule-1' });
  });

  it.each([
    ['no subject', { chat: 'yes' }],
    ['two subjects', { roleId: 'a', userId: 'b' }],
    ['a value it does not know', { roleId: 'a', chat: 'maybe' }],
    ['an action it does not know', { roleId: 'a', talk: 'yes' }],
  ])('answers 400 for %s', async (_name, body) => {
    expect((await call(PUT_RULE, 'PUT', body, { path: '/rules' })).status).toBe(400);
    expect(mocked.saveBotRule).not.toHaveBeenCalled();
  });

  it('tells the owner why a rule was refused, with the status', async () => {
    mocked.saveBotRule.mockRejectedValue(new settings.BotSettingsError(400, 'Admin always passes, so a rule for it would do nothing'));
    const response = await call(PUT_RULE, 'PUT', { roleId: 'r-admin', chat: 'no' }, { path: '/rules' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Admin always passes, so a rule for it would do nothing' });
  });

  it('answers 500 when saving fails, never success', async () => {
    mocked.saveBotRule.mockRejectedValue(new Error('down'));
    expect((await call(PUT_RULE, 'PUT', { roleId: 'r-acc', chat: 'yes' }, { path: '/rules' })).status).toBe(500);
  });
});

describe('taking a row off', () => {
  it('removes a role’s or a person’s row', async () => {
    expect((await call(DELETE_RULE, 'DELETE', undefined, { path: '/rules?roleId=r-acc' })).status).toBe(200);
    expect(mocked.deleteBotRule).toHaveBeenCalledWith('bot-1', { roleId: 'r-acc', userId: null });
    await call(DELETE_RULE, 'DELETE', undefined, { path: '/rules?userId=u-mishari' });
    expect(mocked.deleteBotRule).toHaveBeenLastCalledWith('bot-1', { roleId: null, userId: 'u-mishari' });
  });

  it('answers 404, not success, when there was no such row', async () => {
    mocked.deleteBotRule.mockResolvedValue(false);
    const response = await call(DELETE_RULE, 'DELETE', undefined, { path: '/rules?roleId=r-acc' });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/no rule/i);
  });

  it('answers 400 when it is not told whose row', async () => {
    mocked.deleteBotRule.mockRejectedValue(new settings.BotSettingsError(400, 'Name exactly one of roleId or userId'));
    expect((await call(DELETE_RULE, 'DELETE', undefined, { path: '/rules' })).status).toBe(400);
  });
});
