/**
 * /api/bots/:id/mcp-servers/:serverId/tools, /tools/:toolId, /tools/confirm, /policy and /api/bots/:id/tool-settings
 * (#738): who may read and change a bot's tool settings, and that someone without Manage bots gets a 403.
 */
import { NextRequest } from 'next/server';
import { GET as GET_TOOLS, PUT as PUT_TOOLS } from '@/app/api/bots/[id]/mcp-servers/[serverId]/tools/route';
import { PATCH as PATCH_TOOL } from '@/app/api/bots/[id]/mcp-servers/[serverId]/tools/[toolId]/route';
import { POST as CONFIRM } from '@/app/api/bots/[id]/mcp-servers/[serverId]/tools/confirm/route';
import { PUT as PUT_POLICY } from '@/app/api/bots/[id]/mcp-servers/[serverId]/policy/route';
import { GET as GET_SETTINGS, PUT as PUT_SETTINGS } from '@/app/api/bots/[id]/tool-settings/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { canManageBotMcpServers } from '@/lib/bot-permissions';
import * as policy from '@/lib/mcp-tool-policy';
import { BotSettingsError } from '@/lib/bot-access-settings';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/db', () => ({ prisma: { bot: { findUnique: jest.fn() } } }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/bot-permissions', () => ({ canManageBotMcpServers: jest.fn() }));
jest.mock('@/lib/mcp-tool-policy', () => ({
  ...jest.requireActual('@/lib/mcp-tool-policy'),
  readServerTools: jest.fn(),
  syncCatalog: jest.fn(),
  moveTool: jest.fn(),
  confirmTools: jest.fn(),
  saveServerSettings: jest.fn(),
  readBotToolSettings: jest.fn(),
  saveBotToolSettings: jest.fn(),
}));

const session = getSessionUser as jest.Mock;
const manages = canManageBotMcpServers as jest.Mock;
const findBot = prisma.bot.findUnique as jest.Mock;
const MOCKED = ['readServerTools', 'syncCatalog', 'moveTool', 'confirmTools', 'saveServerSettings', 'readBotToolSettings', 'saveBotToolSettings'] as const;
const lib = policy as unknown as Record<(typeof MOCKED)[number], jest.Mock>;

const BOT = { id: 'bot-1', createdById: 'u-maker', roomId: 'room-1' };
const TOOLS = { serverId: 'srv-1', state: 'notConfirmedYet', policyRevision: 1, settings: {}, tools: [] };
const params = { params: Promise.resolve({ id: 'bot-1', serverId: 'srv-1', toolId: 't1' }) };

type Handler = (r: NextRequest, c: typeof params) => Promise<Response>;
const call = (handler: Handler, method: string, body?: unknown, token?: string) =>
  handler(
    new NextRequest('http://localhost:3333/api/bots/bot-1/x', {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
    params,
  );

const CATALOG = { tools: [{ name: 'a', fingerprint: 'f', suggestedHeading: 'looksUp', suggestionSource: 'server' }] };

beforeEach(() => {
  process.env.ADMIN_API_TOKEN = 'admin-secret';
  session.mockReset().mockResolvedValue({ id: 'u-sara', email: 'sara@example.com' });
  manages.mockReset().mockResolvedValue(true);
  findBot.mockReset().mockResolvedValue(BOT);
  for (const name of MOCKED) lib[name].mockReset();
  lib.readServerTools.mockResolvedValue(TOOLS);
  lib.syncCatalog.mockResolvedValue({ ...TOOLS, added: ['a'], changed: [], removed: [] });
  lib.moveTool.mockResolvedValue(TOOLS);
  lib.confirmTools.mockResolvedValue(TOOLS);
  lib.saveServerSettings.mockResolvedValue(TOOLS);
  lib.readBotToolSettings.mockResolvedValue({ askBeforeMaking: 5, askWhichWay: 'rarely', cardWaitMinutes: 10 });
  lib.saveBotToolSettings.mockResolvedValue({ askBeforeMaking: 3, askWhichWay: 'rarely', cardWaitMinutes: 10 });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const everything: [string, Handler, string, unknown][] = [
  ['read tools', GET_TOOLS as Handler, 'GET', undefined],
  ['move a tool', PATCH_TOOL as Handler, 'PATCH', { heading: 'looksUp' }],
  ['confirm tools', CONFIRM as Handler, 'POST', {}],
  ['save settings', PUT_POLICY as Handler, 'PUT', { looksUp: 'off' }],
  ['read bot settings', GET_SETTINGS as Handler, 'GET', undefined],
  ['save bot settings', PUT_SETTINGS as Handler, 'PUT', { askBeforeMaking: 3 }],
];

describe('who may reach the tool settings', () => {
  it.each(everything)('%s: 401 for someone not signed in and holding no token', async (_name, handler, method, body) => {
    session.mockResolvedValue(null);
    expect((await call(handler, method, body)).status).toBe(401);
  });

  it.each(everything)('%s: 403 for someone signed in without Manage bots, and nothing is read or saved', async (_name, handler, method, body) => {
    manages.mockResolvedValue(false);
    const response = await call(handler, method, body);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
    for (const name of MOCKED) expect(lib[name]).not.toHaveBeenCalled();
  });

  it.each(everything)('%s: 404 for a bot that is not there', async (_name, handler, method, body) => {
    findBot.mockResolvedValue(null);
    expect((await call(handler, method, body)).status).toBe(404);
  });

  it('asks whether this person manages this bot, with no extra way in for its creator', async () => {
    await call(GET_TOOLS as Handler, 'GET');
    expect(manages).toHaveBeenCalledWith('u-sara', 'sara@example.com', BOT);
  });

  it('lets the bot server read with its admin token, but not move, confirm or change settings', async () => {
    session.mockResolvedValue(null);
    expect((await call(GET_TOOLS as Handler, 'GET', undefined, 'admin-secret')).status).toBe(200);
    expect((await call(GET_SETTINGS as Handler, 'GET', undefined, 'admin-secret')).status).toBe(200);
    for (const [, handler, method, body] of everything.filter(([name]) => !name.startsWith('read'))) {
      expect((await call(handler, method, body, 'admin-secret')).status).toBe(401);
    }
    expect((await call(GET_TOOLS as Handler, 'GET', undefined, 'wrong')).status).toBe(401);
  });

  it('lets only the bot server save the tool list: a person gets 403, even one who manages the bot', async () => {
    expect((await call(PUT_TOOLS as Handler, 'PUT', CATALOG)).status).toBe(403);
    expect(lib.syncCatalog).not.toHaveBeenCalled();
    session.mockResolvedValue(null);
    expect((await call(PUT_TOOLS as Handler, 'PUT', CATALOG, 'wrong')).status).toBe(401);
    expect((await call(PUT_TOOLS as Handler, 'PUT', CATALOG, 'admin-secret')).status).toBe(200);
    expect(lib.syncCatalog).toHaveBeenCalledWith('bot-1', 'srv-1', expect.objectContaining({ tools: expect.any(Array) }));
  });
});

describe('what each one does', () => {
  it('reads the tools for the server named', async () => {
    const response = await call(GET_TOOLS as Handler, 'GET');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(TOOLS);
    expect(lib.readServerTools).toHaveBeenCalledWith('bot-1', 'srv-1');
  });

  it('moves a tool as the person who asked', async () => {
    await call(PATCH_TOOL as Handler, 'PATCH', { heading: 'deletesOrSends' });
    expect(lib.moveTool).toHaveBeenCalledWith('bot-1', 'srv-1', 't1', 'deletesOrSends', 'u-sara');
  });

  it('confirms all tools, or the ones listed, as the person who asked', async () => {
    await call(CONFIRM as Handler, 'POST', {});
    expect(lib.confirmTools).toHaveBeenLastCalledWith('bot-1', 'srv-1', 'u-sara', undefined);
    await call(CONFIRM as Handler, 'POST', { toolIds: ['t1'] });
    expect(lib.confirmTools).toHaveBeenLastCalledWith('bot-1', 'srv-1', 'u-sara', ['t1']);
    await call(CONFIRM as Handler, 'POST');
    expect(lib.confirmTools).toHaveBeenCalledTimes(3);
  });

  it('saves settings and a bot’s limits', async () => {
    await call(PUT_POLICY as Handler, 'PUT', { changesThings: 'off' });
    expect(lib.saveServerSettings).toHaveBeenCalledWith('bot-1', 'srv-1', { changesThings: 'off' });
    const response = await call(PUT_SETTINGS as Handler, 'PUT', { askBeforeMaking: 3 });
    expect(await response.json()).toEqual({ askBeforeMaking: 3, askWhichWay: 'rarely', cardWaitMinutes: 10 });
    expect(lib.saveBotToolSettings).toHaveBeenCalledWith('bot-1', { askBeforeMaking: 3 });
  });

  it('refuses a body that is not valid with 400, and saves nothing', async () => {
    for (const [handler, body] of [
      [PATCH_TOOL, { heading: 'nope' }],
      [PUT_POLICY, { looksUp: 'always' }],
      [PUT_POLICY, {}],
      [PUT_SETTINGS, { cardWaitMinutes: 15 }],
      [PUT_SETTINGS, 'not json'],
    ] as [Handler, unknown][]) {
      expect((await call(handler, 'PUT', body)).status).toBe(400);
    }
    expect((await call(CONFIRM as Handler, 'POST', { toolIds: [] })).status).toBe(400);
    session.mockResolvedValue(null);
    expect((await call(PUT_TOOLS as Handler, 'PUT', { tools: [{ name: 'a' }] }, 'admin-secret')).status).toBe(400);
    for (const fn of [lib.moveTool, lib.saveServerSettings, lib.saveBotToolSettings, lib.confirmTools, lib.syncCatalog]) expect(fn).not.toHaveBeenCalled();
  });

  it('passes on a failure it can explain, and reports one it cannot', async () => {
    lib.confirmTools.mockRejectedValue(new BotSettingsError(400, 'Choose what x does before confirming'));
    const refused = await call(CONFIRM as Handler, 'POST', {});
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'Choose what x does before confirming' });
    lib.confirmTools.mockRejectedValue(new Error('database down'));
    expect((await call(CONFIRM as Handler, 'POST', {})).status).toBe(500);
  });
});
