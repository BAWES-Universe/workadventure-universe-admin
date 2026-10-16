import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { PATCH } from '@/app/api/admin/bots/[id]/route';
import { transformBotToServerFormat } from '@/lib/bot-config-helpers';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';

jest.mock('@/lib/db', () => ({ prisma: { $queryRaw: jest.fn() } }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn() }));

function save(body: unknown, id = 'bot-a') {
  return PATCH(
    new NextRequest('http://localhost/api/admin/bots/' + id, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionUser as jest.Mock).mockResolvedValue({ id: 'admin', email: 'admin@example.com' });
  (isSuperAdmin as jest.Mock).mockReturnValue(true);
  (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ id: 'bot-a' }]);
});

test('sets and clears one bot atomically, preserving its other JSON and the other bot', async () => {
  expect((await save({ showToolCalls: true })).status).toBe(200);
  expect((await save({ showToolCalls: false })).status).toBe(200);
  const queries = (prisma.$queryRaw as jest.Mock).mock.calls.map(([query]) => ({
    text: query.text,
    values: query.values,
  }));
  const output = execFileSync(
    process.execPath,
    [path.join(__dirname, '../../helpers/run-bot-tool-call-setting.mjs')],
    {
      input: JSON.stringify(queries),
      encoding: 'utf8',
    }
  );
  const snapshots = JSON.parse(output);
  expect(snapshots[0]).toEqual([
    expect.objectContaining({
      id: 'bot-a',
      behavior_config: { moves: 'route', waypoints: [{ x: 32, y: 64 }], showToolCalls: true },
      updated_by_id: 'admin',
    }),
    expect.objectContaining({ id: 'bot-b', behavior_config: {}, updated_at: null }),
  ]);
  expect(snapshots[1][0].behavior_config.showToolCalls).toBe(false);
  expect(snapshots[1][0].behavior_config.moves).toBe('route');
});

test.each([
  {},
  { showToolCalls: 'true' },
  { showToolCalls: null },
  { showToolCalls: true, enabled: false },
])('rejects invalid payload %j', async (body) => {
  expect((await save(body)).status).toBe(400);
  expect(prisma.$queryRaw).not.toHaveBeenCalled();
});
test('denies a non-admin before writing', async () => {
  (isSuperAdmin as jest.Mock).mockReturnValue(false);
  expect((await save({ showToolCalls: true })).status).toBe(403);
  expect(prisma.$queryRaw).not.toHaveBeenCalled();
});
test('denies missing session before writing', async () => {
  (getSessionUser as jest.Mock).mockResolvedValue(null);
  expect((await save({ showToolCalls: true })).status).toBe(403);
  expect(prisma.$queryRaw).not.toHaveBeenCalled();
});
test('reports a deleted bot', async () => {
  (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);
  expect((await save({ showToolCalls: true }, 'missing')).status).toBe(404);
});

test.each([undefined, false, true, 'true'])(
  'server config only enables explicit boolean true (%s)',
  async (setting) => {
    const output = await transformBotToServerFormat(
      {
        id: 'bot-a',
        behaviorConfig: { showToolCalls: setting, moves: 'route' },
        behaviorType: 'patrol',
        room: { slug: 'room', world: { slug: 'world', universe: { slug: 'universe' } } },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      false,
      false
    );
    expect(output.behaviorConfig.showToolCalls).toBe(setting === true);
    expect(output.behaviorConfig.moves).toBe('route');
  }
);
