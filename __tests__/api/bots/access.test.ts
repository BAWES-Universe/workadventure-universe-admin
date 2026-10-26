import { NextRequest } from 'next/server';
import { POST } from '@/app/api/bots/[id]/access/route';
import { checkBotAccess } from '@/lib/bot-access';

jest.mock('@/lib/bot-access', () => ({
  ...jest.requireActual('@/lib/bot-access'),
  checkBotAccess: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const check = checkBotAccess as jest.Mock;
const TOKEN = 'service-secret';

function post(body: unknown, token: string | null = TOKEN) {
  return POST(
    new NextRequest('http://localhost:3333/api/bots/bot-1/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'bot-1' }) },
  );
}

beforeEach(() => {
  process.env.BOT_SERVICE_TOKEN = TOKEN;
  check.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('POST /api/bots/[id]/access', () => {
  it('answers 401 without the service token, and never looks anything up', async () => {
    expect((await post({ action: 'chat', person: { signedIn: false } }, null)).status).toBe(401);
    expect((await post({ action: 'chat', person: { signedIn: false } }, 'wrong')).status).toBe(401);
    expect(check).not.toHaveBeenCalled();
  });

  it('answers 401 when no service token is configured', async () => {
    delete process.env.BOT_SERVICE_TOKEN;
    expect((await post({ action: 'chat', person: { signedIn: false } })).status).toBe(401);
  });

  it.each([
    ['not JSON', 'not json'],
    ['no action', { person: { signedIn: false } }],
    ['an unknown action', { action: 'manage', person: { signedIn: false } }],
    ['no person', { action: 'chat' }],
    ['a signed-in person with no identifier', { action: 'dm', person: { signedIn: true } }],
    ['a signed-in person with an empty identifier', { action: 'dm', person: { signedIn: true, identifier: '  ' } }],
    ['a chat ID for anything but a direct message', { action: 'chat', person: { signedIn: true, chatId: '@a:chat.example' } }],
    ['a chat ID and an identifier together', { action: 'dm', person: { signedIn: true, identifier: 'a@example.com', chatId: '@a:chat.example' } }],
  ])('answers 400 for %s', async (_name, body) => {
    expect((await post(body)).status).toBe(400);
    expect(check).not.toHaveBeenCalled();
  });

  it('answers 404 for a bot that does not exist, so the caller can tell it from a no', async () => {
    check.mockResolvedValue(null);
    expect((await post({ action: 'chat', person: { signedIn: false } })).status).toBe(404);
  });

  it('passes the question on and returns the answer', async () => {
    check.mockResolvedValue({ allowed: true, code: 'allowed', reason: null });
    const response = await post({ action: 'summon', person: { signedIn: true, identifier: 'sara@example.com' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ allowed: true, code: 'allowed', reason: null });
    expect(check).toHaveBeenCalledWith({ botId: 'bot-1', action: 'summon', person: { signedIn: true, identifier: 'sara@example.com' } });
  });

  it('passes a direct message’s chat ID on, and returns whose it is', async () => {
    check.mockResolvedValue({ allowed: true, code: 'allowed', reason: null, person: { uuid: 'uuid-sara', name: 'Sara' } });
    const response = await post({ action: 'dm', person: { signedIn: true, chatId: '@sara:chat.example' } });
    expect(await response.json()).toEqual({ allowed: true, code: 'allowed', reason: null, person: { uuid: 'uuid-sara', name: 'Sara' } });
    expect(check).toHaveBeenCalledWith({ botId: 'bot-1', action: 'dm', person: { signedIn: true, chatId: '@sara:chat.example' } });
  });

  it('a no is a 200 with the line to show', async () => {
    check.mockResolvedValue({ allowed: false, code: 'sign_in_required', reason: 'Sign in to message Nora.' });
    const response = await post({ action: 'dm', person: { signedIn: false } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ allowed: false, code: 'sign_in_required', reason: 'Sign in to message Nora.' });
  });

  it('answers 500, never a yes, when the database fails, and reports it', async () => {
    check.mockRejectedValue(new Error('database down'));
    const response = await post({ action: 'chat', person: { signedIn: false } });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to check bot access' });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(require('@sentry/nextjs').captureException).toHaveBeenCalled();
  });
});
