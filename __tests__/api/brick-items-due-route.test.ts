/**
 * The bot server asks Orbit for what it can run (game #2002): POST /api/bricks/items/due takes the kinds it runs. A body from before
 * `kinds` is every kind; an unknown kind or field is refused, never read as "every kind".
 */
import { NextRequest } from 'next/server';
import { claimWork } from '@/lib/brick-items';
import { POST } from '@/app/api/bricks/items/due/route';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/brick-items', () => ({ ITEM_KINDS: ['reminder', 'schedule', 'watch', 'goal'], claimWork: jest.fn(async () => ({ runs: [], held: [] })) }));

const claim = claimWork as unknown as jest.Mock;
const ask = (body?: string) => POST(new NextRequest('http://localhost:3333/api/bricks/items/due', { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body }) }));

beforeEach(() => claim.mockClear());

describe('POST /api/bricks/items/due', () => {
  it('claims only the kinds it is asked for', async () => {
    expect((await ask(JSON.stringify({ kinds: ['reminder'] }))).status).toBe(200);
    expect(claim).toHaveBeenCalledWith(expect.any(Date), undefined, undefined, ['reminder']);
  });

  it('claims every kind when it is asked with no kinds, or with no body', async () => {
    expect((await ask(JSON.stringify({}))).status).toBe(200);
    expect((await ask()).status).toBe(200);
    expect(claim.mock.calls.map((call) => call[3])).toEqual([undefined, undefined]);
  });

  it('refuses a kind or a field it does not know, and a body that is not JSON, and claims nothing', async () => {
    for (const body of [JSON.stringify({ kinds: ['quest'] }), JSON.stringify({ kinds: 'reminder' }), JSON.stringify({ kind: ['reminder'] }), 'nope']) {
      expect((await ask(body)).status).toBe(400);
    }
    expect(claim).not.toHaveBeenCalled();
  });
});
