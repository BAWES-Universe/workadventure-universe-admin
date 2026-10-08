/**
 * A player's chat ID (Matrix user ID) is only saved once the game has checked it with the Matrix server:
 * - PUT /api/members/:id/chatId saves it for that account and takes it off any other account;
 * - GET /api/room/access never saves the chat ID it is given (the browser could claim anyone's).
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    user: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    world: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('@/lib/oidc', () => ({ authenticateRequest: jest.fn() }));
jest.mock('@/lib/discord', () => ({ notifyRoomAccess: jest.fn() }));

import { prisma } from '@/lib/db';
import { authenticateRequest } from '@/lib/oidc';
import { PUT } from '@/app/api/members/[memberUUID]/chatId/route';
import { GET as roomAccess } from '@/app/api/room/access/route';

const db = prisma as unknown as {
  user: Record<string, jest.Mock>;
  world: Record<string, jest.Mock>;
  $transaction: jest.Mock;
};
const authenticate = authenticateRequest as unknown as jest.Mock;

const ALICE = {
  id: 'id-alice',
  uuid: 'alice@example.test',
  email: 'alice@example.test',
  name: 'Alice',
  matrixChatId: null,
  isGuest: false,
};

function putChatId(identifier: string, body: unknown, authorized = true) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authorized) headers.Authorization = process.env.ADMIN_API_TOKEN as string;
  return PUT(
    new NextRequest(`http://localhost:3333/api/members/${encodeURIComponent(identifier)}/chatId`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ memberUUID: encodeURIComponent(identifier) }) }
  );
}

function roomAccessRequest(query: Record<string, string>) {
  const url = new URL('http://localhost:3333/api/room/access');
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new NextRequest(url, { headers: { Authorization: process.env.ADMIN_API_TOKEN as string } });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.$transaction.mockImplementation((operations: unknown[]) => Promise.all(operations));
  db.user.updateMany.mockResolvedValue({ count: 0 });
  db.user.update.mockImplementation(({ data }: { data: object }) => Promise.resolve({ ...ALICE, ...data }));
});

describe('PUT /api/members/:id/chatId', () => {
  it('saves the chat ID on the account and takes it off any other account, in one transaction', async () => {
    db.user.findFirst.mockResolvedValue(ALICE);

    const response = await putChatId(ALICE.email, { chatId: '@alice:matrix.example.test' });

    expect(response.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { matrixChatId: '@alice:matrix.example.test', id: { not: 'id-alice' } },
      data: { matrixChatId: null },
    });
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: 'id-alice' },
      data: { matrixChatId: '@alice:matrix.example.test' },
    });
  });

  it.each([['alice'], ['@alice'], ['@:server'], ['@ali ce:server'], [42]])(
    'refuses %p, which is not a Matrix user ID',
    async (chatId) => {
      db.user.findFirst.mockResolvedValue(ALICE);

      const response = await putChatId(ALICE.email, { chatId });

      expect(response.status).toBe(400);
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );

  it('needs the admin token', async () => {
    const response = await putChatId(ALICE.email, { chatId: '@alice:matrix.example.test' }, false);

    expect(response.status).toBe(401);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown account', async () => {
    db.user.findFirst.mockResolvedValue(null);
    db.user.findMany.mockResolvedValue([]);

    const response = await putChatId('nobody@example.test', { chatId: '@nobody:matrix.example.test' });

    expect(response.status).toBe(404);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe('GET /api/room/access', () => {
  const query = {
    userIdentifier: ALICE.email,
    playUri: 'https://play.example.test/@/acme/office/lobby',
    accessToken: 'oidc-access-token',
    chatID: '@someone-else:matrix.example.test',
  };

  beforeEach(() => {
    authenticate.mockResolvedValue({ isAuthenticated: true, identifier: ALICE.uuid, email: ALICE.email, name: 'Alice' });
    // Stops right after the user is saved.
    db.world.findFirst.mockResolvedValue(null);
  });

  it('does not save the chat ID it is given on an existing account', async () => {
    db.user.findFirst.mockResolvedValue({ ...ALICE, matrixChatId: '@alice:matrix.example.test' });

    await roomAccess(roomAccessRequest(query));

    expect(db.user.update).toHaveBeenCalledTimes(1);
    expect(db.user.update.mock.calls[0][0].data).not.toHaveProperty('matrixChatId');
  });

  it('does not save the chat ID it is given on a new account', async () => {
    db.user.findFirst.mockResolvedValue(null);
    db.user.create.mockImplementation(({ data }: { data: object }) => Promise.resolve({ id: 'id-new', ...data }));

    await roomAccess(roomAccessRequest(query));

    expect(db.user.create).toHaveBeenCalledTimes(1);
    expect(db.user.create.mock.calls[0][0].data).not.toHaveProperty('matrixChatId');
  });
});
