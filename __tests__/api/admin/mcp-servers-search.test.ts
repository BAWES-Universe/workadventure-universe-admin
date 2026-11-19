/**
 * The admin list of MCP servers searches what it shows. A grant on a person's connection shows the connection's name and link, so
 * a search for either finds it, not only the grant's own columns.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({ prisma: { botMcpServer: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) } } }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn(() => true) }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { GET } from '@/app/api/admin/mcp-servers/route';

describe('GET /api/admin/mcp-servers search', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSessionUser as jest.Mock).mockResolvedValue({ id: 'admin', email: 'admin@example.com' });
  });

  it("finds a grant by the name or the link of the person's connection it shows", async () => {
    await GET(new NextRequest('http://localhost/api/admin/mcp-servers?search=acme'));
    const where = (prisma.botMcpServer.findMany as jest.Mock).mock.calls[0][0].where as { OR: unknown[] };
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { connection: { is: { name: { contains: 'acme', mode: 'insensitive' } } } },
        { connection: { is: { serverUrl: { contains: 'acme', mode: 'insensitive' } } } },
      ]),
    );
    expect((prisma.botMcpServer.count as jest.Mock).mock.calls[0][0].where).toBe(where);
  });
});
