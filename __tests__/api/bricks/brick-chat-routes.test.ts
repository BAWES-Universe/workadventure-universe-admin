/**
 * What the bot server asks for a person's Brick (game #1996): making another Brick from their own chat with it, and the
 * gentle offer. Both are for the bot server's token only, and say only what the libraries decided: who owns what is
 * tested against a real database in brick-delete-db.test.ts.
 */
import { NextRequest } from 'next/server';
import { GET as listForChat, POST as makeFromChat } from '@/app/api/bots/[id]/bricks/route';
import { GET as offers, POST as claim, PUT as answer } from '@/app/api/bots/[id]/brick-offers/route';
import { bricksForChat, makeBrickFromChat } from '@/lib/brick-make';
import { answerOffer, claimOffer, offersSoFar, topicKey } from '@/lib/brick-offers';

jest.mock('@/lib/db', () => ({ prisma: {} }));
jest.mock('@/lib/brick-make', () => ({ ...jest.requireActual('@/lib/brick-make'), bricksForChat: jest.fn(), makeBrickFromChat: jest.fn() }));
jest.mock('@/lib/brick-offers', () => ({ ...jest.requireActual('@/lib/brick-offers'), offersSoFar: jest.fn(), claimOffer: jest.fn(), answerOffer: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const list = bricksForChat as jest.Mock;
const make = makeBrickFromChat as jest.Mock;
const soFar = offersSoFar as jest.Mock;
const claimed = claimOffer as jest.Mock;
const answered = answerOffer as jest.Mock;

const SERVICE_TOKEN = 'bot-server-secret';
const BRICK_ID = '7b0f3c1e-52a4-4d0b-9a3e-6f1d2c3b4a5e';
const card = { id: BRICK_ID, name: 'Brick', description: 'Your everyday helper', characterTextureId: 'brick-orange', enabled: true, isDefault: true, hello: null, createdAt: '2026-11-11T00:00:00.000Z' };
const madeCard = { ...card, id: 'made-1', name: 'Recipe Brick', characterTextureId: 'brick-red', isDefault: false };
const NOT_THERE = { ok: false, status: 404, error: 'Brick not found' };

function request(path: string, init: { method?: string; body?: unknown; rawBody?: string; token?: string | null } = {}) {
  const token = init.token === undefined ? SERVICE_TOKEN : init.token;
  return new NextRequest(`http://localhost:3333${path}`, {
    method: init.method ?? 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(init.rawBody !== undefined ? { body: init.rawBody } : init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}
const params = { params: Promise.resolve({ id: BRICK_ID }) };
const tokenBefore = process.env.BOT_SERVICE_TOKEN;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
});
afterAll(() => {
  if (tokenBefore === undefined) delete process.env.BOT_SERVICE_TOKEN;
  else process.env.BOT_SERVICE_TOKEN = tokenBefore;
});

describe('every one of them is for the bot server only', () => {
  it.each([
    ['listing', () => listForChat(request(`/api/bots/${BRICK_ID}/bricks?userId=u`, { token: null }), params)],
    ['making', () => makeFromChat(request(`/api/bots/${BRICK_ID}/bricks`, { method: 'POST', body: { userId: 'u', name: 'Mine' }, token: 'wrong' }), params)],
    ['reading offers', () => offers(request(`/api/bots/${BRICK_ID}/brick-offers?userId=u`, { token: null }), params)],
    ['claiming an offer', () => claim(request(`/api/bots/${BRICK_ID}/brick-offers`, { method: 'POST', body: { userId: 'u', topic: 'recipes' }, token: 'wrong' }), params)],
    ['keeping an answer', () => answer(request(`/api/bots/${BRICK_ID}/brick-offers`, { method: 'PUT', body: { userId: 'u', topic: 'recipes', answer: 'made' }, token: null }), params)],
  ])('%s answers 401 without its token, and nothing is asked', async (_what, ask) => {
    expect((await ask()).status).toBe(401);
    for (const fn of [list, make, soFar, claimed, answered]) expect(fn).not.toHaveBeenCalled();
  });
});

describe('POST /api/bots/:id/bricks: "make me a bot that keeps my mum’s recipes"', () => {
  it('makes the Brick for the person who asked, and answers 201 with it and their Bricks', async () => {
    make.mockResolvedValue({ ok: true, made: true, brick: madeCard, bricks: [card, madeCard] });
    const response = await makeFromChat(
      request(`/api/bots/${BRICK_ID}/bricks`, { method: 'POST', body: { userId: ' uuid-sara ', name: ' Recipe Brick ', description: 'Keeps your mum’s recipes', chatInstructions: 'Keep recipes.', hello: 'Send me the first recipe.' } }),
      params,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ made: true, brick: madeCard, bricks: [card, madeCard] });
    expect(make).toHaveBeenCalledWith(BRICK_ID, { userId: 'uuid-sara', name: 'Recipe Brick', description: 'Keeps your mum’s recipes', chatInstructions: 'Keep recipes.', hello: 'Send me the first recipe.' });
  });

  it('answers 200 with the one they already have, when nothing was made', async () => {
    make.mockResolvedValue({ ok: true, made: false, brick: madeCard, bricks: [card, madeCard] });
    const response = await makeFromChat(request(`/api/bots/${BRICK_ID}/bricks`, { method: 'POST', body: { userId: 'uuid-sara', name: 'Recipe Brick' } }), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ made: false, brick: { id: 'made-1' } });
  });

  it('is not there for anyone who does not own the Brick that asks', async () => {
    make.mockResolvedValue(NOT_THERE);
    const response = await makeFromChat(request(`/api/bots/${BRICK_ID}/bricks`, { method: 'POST', body: { userId: 'uuid-omar', name: 'Mine' } }), params);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Brick not found' });
  });

  it.each([
    ['no person', { name: 'Mine' }],
    ['no name', { userId: 'uuid-sara' }],
    ['an owner', { userId: 'uuid-sara', name: 'Mine', ownerId: 'u-omar' }],
    ['a room', { userId: 'uuid-sara', name: 'Mine', roomId: 'room-1' }],
    ['a key', { userId: 'uuid-sara', name: 'Mine', aiProviderRef: 'key-1' }],
  ])('refuses a body with %s, and makes nothing', async (_what, body) => {
    expect((await makeFromChat(request(`/api/bots/${BRICK_ID}/bricks`, { method: 'POST', body }), params)).status).toBe(400);
    expect((await makeFromChat(request(`/api/bots/${BRICK_ID}/bricks`, { method: 'POST', rawBody: 'not json' }), params)).status).toBe(400);
    expect(make).not.toHaveBeenCalled();
  });
});

describe('GET /api/bots/:id/bricks: the person’s Bricks, for their Brick', () => {
  it('lists them for the owner of the Brick that asks, and is not there for anyone else', async () => {
    list.mockResolvedValue([card, madeCard]);
    const mine = await listForChat(request(`/api/bots/${BRICK_ID}/bricks?userId=uuid-sara`), params);
    expect(await mine.json()).toEqual({ bricks: [card, madeCard] });
    expect(list).toHaveBeenCalledWith(BRICK_ID, 'uuid-sara');
    list.mockResolvedValue(null);
    expect((await listForChat(request(`/api/bots/${BRICK_ID}/bricks?userId=uuid-omar`), params)).status).toBe(404);
    expect((await listForChat(request(`/api/bots/${BRICK_ID}/bricks`), params)).status).toBe(400);
  });
});

describe('/api/bots/:id/brick-offers: the gentle offer', () => {
  it('tells a Brick how often a job has to come back and what was already suggested', async () => {
    soFar.mockResolvedValue({ ok: true, after: 3, topics: [{ topic: 'recipes', answer: 'not_now' }] });
    const response = await offers(request(`/api/bots/${BRICK_ID}/brick-offers?userId=uuid-sara`), params);
    expect(await response.json()).toEqual({ after: 3, topics: [{ topic: 'recipes', answer: 'not_now' }] });
    expect(soFar).toHaveBeenCalledWith(BRICK_ID, 'uuid-sara');
    expect((await offers(request(`/api/bots/${BRICK_ID}/brick-offers`), params)).status).toBe(400);
  });

  it('says whether the card may be shown, and keeps what the person tapped', async () => {
    claimed.mockResolvedValue({ ok: true, show: true, topic: 'recipes' });
    expect(await (await claim(request(`/api/bots/${BRICK_ID}/brick-offers`, { method: 'POST', body: { userId: 'uuid-sara', topic: 'Recipes' } }), params)).json()).toEqual({ show: true, topic: 'recipes' });
    expect(claimed).toHaveBeenCalledWith(BRICK_ID, { userId: 'uuid-sara', topic: 'Recipes' });
    answered.mockResolvedValue({ ok: true, kept: true });
    expect(await (await answer(request(`/api/bots/${BRICK_ID}/brick-offers`, { method: 'PUT', body: { userId: 'uuid-sara', topic: 'Recipes', answer: 'not_now' } }), params)).json()).toEqual({ kept: true });
    expect(answered).toHaveBeenCalledWith(BRICK_ID, { userId: 'uuid-sara', topic: 'Recipes', answer: 'not_now' });
  });

  it('is not there for anyone who does not own the Brick that asks', async () => {
    soFar.mockResolvedValue(NOT_THERE);
    claimed.mockResolvedValue(NOT_THERE);
    answered.mockResolvedValue(NOT_THERE);
    expect((await offers(request(`/api/bots/${BRICK_ID}/brick-offers?userId=uuid-omar`), params)).status).toBe(404);
    expect((await claim(request(`/api/bots/${BRICK_ID}/brick-offers`, { method: 'POST', body: { userId: 'uuid-omar', topic: 'recipes' } }), params)).status).toBe(404);
    expect((await answer(request(`/api/bots/${BRICK_ID}/brick-offers`, { method: 'PUT', body: { userId: 'uuid-omar', topic: 'recipes', answer: 'made' } }), params)).status).toBe(404);
  });

  it('refuses a body it cannot read: no person, no topic, an answer that is not one of the two, or anything extra', async () => {
    for (const body of [{ topic: 'recipes' }, { userId: 'uuid-sara' }, { userId: 'uuid-sara', topic: 'recipes', extra: 1 }]) {
      expect((await claim(request(`/api/bots/${BRICK_ID}/brick-offers`, { method: 'POST', body }), params)).status).toBe(400);
    }
    for (const body of [{ userId: 'uuid-sara', topic: 'recipes' }, { userId: 'uuid-sara', topic: 'recipes', answer: 'later' }]) {
      expect((await answer(request(`/api/bots/${BRICK_ID}/brick-offers`, { method: 'PUT', body }), params)).status).toBe(400);
    }
    expect(claimed).not.toHaveBeenCalled();
    expect(answered).not.toHaveBeenCalled();
  });

  it('reads "Recipes", "recipes!" and " my   RECIPES " as topics by their words only', () => {
    expect(topicKey('Recipes')).toBe('recipes');
    expect(topicKey('recipes!')).toBe('recipes');
    expect(topicKey(' my   RECIPES ')).toBe('my recipes');
    expect(topicKey('وصفات الطبخ')).toBe('وصفات الطبخ');
    expect(topicKey(' ?! ')).toBeNull();
    expect(topicKey(42)).toBeNull();
    expect(topicKey('x'.repeat(200))).toHaveLength(60);
  });
});
