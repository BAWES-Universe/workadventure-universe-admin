import { prisma } from './db';
import { validateAccessToken } from './oidc';
import { sessionStore } from './session-store';

export interface SessionExchangeResponse {
  version: 2;
  sessionId: string;
  expiresAt: number;
}

export class SessionExchangeError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'SessionExchangeError';
  }
}

function tagsFromUserInfo(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((tag): tag is string => typeof tag === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [value];
  } catch {
    return [value];
  }
}

export async function exchangeOidcAccessToken(accessToken: string): Promise<SessionExchangeResponse> {
  const userInfo = await validateAccessToken(accessToken);
  if (!userInfo) throw new SessionExchangeError(401, 'Invalid or expired access token');

  const subject = typeof userInfo.sub === 'string' ? userInfo.sub.trim() : '';
  if (!subject) throw new SessionExchangeError(401, 'Validated identity is missing a subject');

  const email = typeof userInfo.email === 'string' && userInfo.email.trim() ? userInfo.email.trim() : null;
  const suggestedName = typeof userInfo.name === 'string'
    ? userInfo.name
    : typeof userInfo.preferred_username === 'string' ? userInfo.preferred_username : null;

  let user = await prisma.user.findUnique({ where: { uuid: subject } });
  if (email) {
    const emailOwner = await prisma.user.findUnique({ where: { email } });
    if (emailOwner && emailOwner.id !== user?.id) {
      throw new SessionExchangeError(409, 'Identity conflict: email belongs to another subject');
    }
  }

  if (user) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { email: email ?? user.email, isGuest: false },
    });
  } else {
    user = await prisma.user.create({
      data: { uuid: subject, email, name: suggestedName, isGuest: false },
    });
  }

  const created = await sessionStore.createSession({
    userId: user.id,
    uuid: user.uuid,
    email: user.email,
    name: user.name,
    tags: tagsFromUserInfo(userInfo.tags),
  });
  return { version: 2, ...created };
}
