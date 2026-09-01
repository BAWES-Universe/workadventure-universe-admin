import { NextRequest, NextResponse } from 'next/server';
import { validateAccessToken } from '@/lib/oidc';
import { prisma } from '@/lib/db';
import { sessionStore } from '@/lib/session-store';

export const runtime = 'nodejs';

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { Allow: 'POST, OPTIONS' } });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const accessToken = typeof body.accessToken === 'string' ? body.accessToken : null;
    if (!accessToken) return NextResponse.json({ error: 'Access token required' }, { status: 400 });

    const userInfo = await validateAccessToken(accessToken);
    if (!userInfo) return NextResponse.json({ error: 'Invalid access token' }, { status: 401 });

    const identifier = userInfo.sub || userInfo.email;
    if (!identifier) return NextResponse.json({ error: 'OIDC subject required' }, { status: 401 });
    const email = userInfo.email || null;
    const name = userInfo.name || userInfo.preferred_username || null;
    let tags: string[] = [];
    if (Array.isArray(userInfo.tags)) tags = userInfo.tags.map(String);
    else if (typeof userInfo.tags === 'string') {
      try { tags = JSON.parse(userInfo.tags); } catch { tags = [userInfo.tags]; }
    }

    let user = await prisma.user.findFirst({
      where: { OR: [{ uuid: identifier }, ...(email ? [{ email }] : [])] },
    });
    if (!user) {
      user = await prisma.user.create({ data: { uuid: identifier, email, name, isGuest: false } });
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { email: email || user.email, isGuest: false },
      });
    }

    const sessionId = await sessionStore.createSession({
      userId: user.id,
      uuid: user.uuid,
      email: user.email,
      name: user.name,
      tags,
    });
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const response = NextResponse.json({
      user: { id: user.id, uuid: user.uuid, email: user.email, name: user.name, tags },
      sessionId,
      expiresAt,
    });
    // Proactively erase legacy forgeable cookies during rollout.
    for (const cookieName of ['user_session', 'admin_session_id']) {
      response.cookies.set(cookieName, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'none', path: '/', maxAge: 0 });
    }
    return response;
  } catch (error) {
    console.error('Login error:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
