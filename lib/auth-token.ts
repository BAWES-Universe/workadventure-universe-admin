import { NextRequest } from 'next/server';
import { isSessionId, sessionStore, type SessionData } from './session-store';

/** Only v2 opaque Authorization credentials are authentication inputs. */
export function getSessionId(request: NextRequest): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const value = authorization.slice('Bearer '.length).trim();
  return isSessionId(value) ? value : null;
}

export const getAuthToken = getSessionId;

export async function getSessionData(sessionId: string): Promise<SessionData | null> {
  if (!isSessionId(sessionId)) return null;
  return sessionStore.getSession(sessionId);
}

export async function parseSessionToken(token: string): Promise<SessionData> {
  const session = await getSessionData(token);
  if (!session) throw new Error('Invalid or expired session');
  return session;
}
