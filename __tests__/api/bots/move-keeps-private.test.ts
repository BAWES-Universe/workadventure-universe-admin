/**
 * Hide bot conversations (#435): a bot's transcripts and memory belong to the bot, not to its room. Moving a hidden bot
 * to a room in a universe that does not hide them must not show what it already wrote.
 */
import { NextRequest } from 'next/server';
import { PUT } from '@/app/api/bots/[id]/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';

jest.mock('@/lib/db', () => ({
  prisma: {
    bot: { findUnique: jest.fn(), update: jest.fn() },
    room: { findUnique: jest.fn() },
    user: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@/lib/auth', () => ({ requireAuth: jest.fn() }));
jest.mock('@/lib/bot-permissions', () => {
  const canManageBots = jest.fn(async () => true);
  return { canManageBots, canManageThisBot: jest.fn(async () => true) };
});
jest.mock('@/lib/oidc', () => ({ validateAccessToken: jest.fn(async () => null) }));

const NEW_ROOM = '3f1c7a5e-9a52-4a52-8d3b-0c0f6d2f9a11';
const db = prisma as unknown as { bot: { findUnique: jest.Mock; update: jest.Mock }; room: { findUnique: jest.Mock } };

/** The bot as the route reads it, and as the privacy check reads it: its own choice and its old universe. */
function botIs(hideConversations: boolean | null, oldUniverseHides: boolean) {
  db.bot.findUnique.mockImplementation(async (args: { select?: { hideConversations?: boolean } }) =>
    args.select?.hideConversations
      ? { hideConversations, room: { world: { universe: { hideBotConversations: oldUniverseHides } } } }
      : { id: 'bot-1', roomId: 'room-old', behaviorConfig: {}, aiProviderRef: null },
  );
}

function newUniverseHides(hides: boolean) {
  db.room.findUnique.mockResolvedValue({ id: NEW_ROOM, world: { universe: { hideBotConversations: hides } } });
}

function move(body: Record<string, unknown> = { roomId: NEW_ROOM }) {
  return PUT(
    new NextRequest('http://localhost:3333/api/bots/bot-1', {
      method: 'PUT',
      headers: { Authorization: `Bearer orb_sess_v2_${'a'.repeat(64)}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'bot-1' }) },
  );
}

const savedData = () => db.bot.update.mock.calls[0][0].data;

describe('PUT /api/bots/:id moving a bot between rooms', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSessionUser as jest.Mock).mockResolvedValue({ id: 'user-1', email: 'owner@example.com' });
    db.bot.update.mockResolvedValue({ id: 'bot-1', roomId: NEW_ROOM });
  });

  it('pins a bot Private when it leaves a hiding universe for one that does not hide', async () => {
    botIs(null, true);
    newUniverseHides(false);
    expect((await move()).status).toBe(200);
    expect(savedData()).toMatchObject({ roomId: NEW_ROOM, hideConversations: true });
  });

  it('pins a bot set to Normal too: it was hidden only because its universe hid it', async () => {
    botIs(false, true);
    newUniverseHides(false);
    await move();
    expect(savedData().hideConversations).toBe(true);
  });

  it('touches nothing about privacy when the bot did not hide (how a move always was)', async () => {
    botIs(null, false);
    newUniverseHides(false);
    await move();
    expect(savedData()).not.toHaveProperty('hideConversations');
  });

  it('leaves a bot already set to Private as it is, and one moving into a hiding universe', async () => {
    botIs(true, false);
    newUniverseHides(false);
    await move();
    expect(savedData()).not.toHaveProperty('hideConversations');

    db.bot.update.mockClear();
    botIs(null, true);
    newUniverseHides(true);
    await move();
    expect(savedData()).not.toHaveProperty('hideConversations');
  });

  it('does not look at privacy at all when the room does not change', async () => {
    botIs(null, true);
    await move({ name: 'Sam' });
    expect(savedData()).toEqual(expect.not.objectContaining({ hideConversations: expect.anything() }));
    expect(db.room.findUnique).not.toHaveBeenCalled();
  });
});
