import { createHash, randomBytes } from 'node:crypto';

let redisClientModule: typeof import('redis') | null = null;
type RedisClient = ReturnType<(typeof import('redis'))['createClient']>;

export const SESSION_ID_PREFIX = 'orb_sess_v2_';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface SessionData {
  userId: string;
  uuid: string;
  email: string | null;
  name: string | null;
  tags: string[];
  createdAt: number;
  expiresAt: number;
}

export function isSessionId(value: string): boolean {
  return new RegExp(`^${SESSION_ID_PREFIX}[0-9a-f]{64}$`).test(value);
}

function sessionKey(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return `orbit:session:v2:${digest}`;
}

class SessionStore {
  private redisClient: RedisClient | null = null;
  private redisInitPromise: Promise<RedisClient | null> | null = null;
  private sessions = new Map<string, SessionData>();

  private async getRedisClient() {
    if (this.redisClient?.isReady) return this.redisClient;
    if (this.redisInitPromise) return this.redisInitPromise;
    this.redisInitPromise = (async () => {
      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('REDIS_URL is required for production session storage');
        }
        return null;
      }
      if (!redisClientModule) redisClientModule = await import('redis');
      const client = redisClientModule.createClient({ url: redisUrl });
      client.on('error', (error: Error) => console.error('[SessionStore] Redis error:', error.message));
      await client.connect();
      this.redisClient = client;
      return client;
    })();
    try {
      return await this.redisInitPromise;
    } finally {
      this.redisInitPromise = null;
    }
  }

  async createSession(data: Omit<SessionData, 'createdAt' | 'expiresAt'>): Promise<string> {
    const sessionId = `${SESSION_ID_PREFIX}${randomBytes(32).toString('hex')}`;
    const createdAt = Date.now();
    const session: SessionData = { ...data, createdAt, expiresAt: createdAt + SESSION_TTL_SECONDS * 1000 };
    const client = await this.getRedisClient();
    if (client) await client.setEx(sessionKey(sessionId), SESSION_TTL_SECONDS, JSON.stringify(session));
    else this.sessions.set(sessionKey(sessionId), session);
    return sessionId;
  }

  async getSession(sessionId: string): Promise<SessionData | null> {
    if (!isSessionId(sessionId)) return null;
    const key = sessionKey(sessionId);
    const client = await this.getRedisClient();
    const raw = client ? await client.get(key) : this.sessions.get(key);
    if (!raw) return null;
    const session = (typeof raw === 'string' ? JSON.parse(raw) : raw) as SessionData;
    if (Date.now() >= session.expiresAt) {
      await this.deleteSession(sessionId);
      return null;
    }
    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!isSessionId(sessionId)) return;
    const key = sessionKey(sessionId);
    const client = await this.getRedisClient();
    if (client) await client.del(key);
    this.sessions.delete(key);
  }
}

export const sessionStore = new SessionStore();
