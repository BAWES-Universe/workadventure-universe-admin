/** @jest-environment node */
import { NextRequest } from 'next/server';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/brick-items', () => ({
  ...jest.requireActual('@/lib/brick-items'),
  markHeldTold: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { POST } from '@/app/api/bricks/items/held/[itemId]/told/route';
import { markHeldTold } from '@/lib/brick-items';

const call = (body: string | undefined) =>
  POST(new NextRequest('http://localhost/api/bricks/items/held/item-1/told', { method: 'POST', body, headers: { 'content-type': 'application/json' } }), {
    params: Promise.resolve({ itemId: 'item-1' }),
  });

describe('POST /api/bricks/items/held/:itemId/told', () => {
  beforeEach(() => jest.mocked(markHeldTold).mockReset());

  it('answers 400, not 500, for a body that is not JSON or does not name the wait', async () => {
    for (const body of [undefined, '{', '{}', JSON.stringify({ waitId: '' }), JSON.stringify({ waitId: 'x', more: 1 })]) {
      expect((await call(body)).status).toBe(400);
    }
    expect(markHeldTold).not.toHaveBeenCalled();
  });

  it('keeps that the person was told, and says whether it was kept', async () => {
    jest.mocked(markHeldTold).mockResolvedValue({ ok: true, told: true });
    const response = await call(JSON.stringify({ waitId: '2026-11-12T10:00:00.000Z' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ told: true });
    expect(markHeldTold).toHaveBeenCalledWith('item-1', '2026-11-12T10:00:00.000Z');
  });

  it('answers 404 for an item that is not there', async () => {
    jest.mocked(markHeldTold).mockResolvedValue({ ok: false, status: 404, error: 'Item not found' });
    expect((await call(JSON.stringify({ waitId: 'x' }))).status).toBe(404);
  });
});
