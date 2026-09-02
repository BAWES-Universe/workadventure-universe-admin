import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionData, getSessionId } from '@/lib/auth-token';
import { isSuperAdmin } from '@/lib/super-admin';

export const runtime = 'nodejs';

function response(body: unknown, status = 200) {
  const result = NextResponse.json(body, { status });
  result.headers.set('Cache-Control', 'no-store');
  return result;
}

export async function GET(request: NextRequest) {
  try {
    const sessionId = getSessionId(request);
    const session = sessionId ? await getSessionData(sessionId) : null;
    if (!session) return response({ error: 'Invalid or expired session' }, 401);

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, uuid: true, email: true, name: true },
    });
    if (!user) return response({ error: 'User not found' }, 404);

    return response({ user: { ...user, tags: session.tags, isSuperAdmin: isSuperAdmin(user.email) } });
  } catch (error) {
    console.error('[Auth Me] Failed:', error);
    return response({ error: 'Internal server error' }, 500);
  }
}
