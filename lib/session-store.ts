import { createHash, randomBytes } from 'node:crypto';

let redisClientModule: typeof import('redis') | null = null;
type RedisClient = ReturnType<(typeof import('redis'))['createClient']>;

export const SESSION_ID_PREFIX = 'orb_sess_v2_';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface CreatedSession {
  sessionId: string;
  expiresAt: number;
}

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
  private lastRedisFailure: number | null = null;
  private static readonly REDIS_RETRY_BACKOFF_MS = 5_000;
  private sessions = new Map<string, SessionData>();

  private async getRedisClient() {
    if (this.redisClient?.isReady) return this.redisClient;
    if (this.redisInitPromise) return this.redisInitPromise;
    // Fail fast during a known outage instead of letting every concurrent
    // request spawn its own connect attempt (retry storm against a down Redis).
    if (this.lastRedisFailure && Date.now() - this.lastRedisFailure < SessionStore.REDIS_RETRY_BACKOFF_MS) {
      throw new Error('Redis unavailable (recent connection failure)');
    }
    this.redisInitPromise = (async () => {
      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('REDIS_URL is required for production session storage');
        }
        return null;
      }
      if (!redisClientModule) redisClientModule = await import('redis');
      // Close any stale client that is no longer ready. node-redis keeps the
      // old client reconnecting in the background, so replacing it without
      // closing it would leak a live connection on every transient disconnect.
      const staleClient = this.redisClient;
      if (staleClient && !staleClient.isReady) {
        try {
          await staleClient.close();
        } catch {
          // already closed
        }
      }
      const client = redisClientModule.createClient({ url: redisUrl });
      client.on('error', (error: Error) => console.error('[SessionStore] Redis error:', error.message));
      try {
        await client.connect();
      } catch (error) {
        this.lastRedisFailure = Date.now();
        // Close the failed client so its background reconnect loop is not
        // leaked; otherwise every failed attempt accumulates a retrying client.
        await client.close().catch(() => undefined);
        throw error;
      }
      this.redisClient = client;
      this.lastRedisFailure = null;
      return client;
    })();
    try {
      return await this.redisInitPromise;
    } finally {
      this.redisInitPromise = null;
    }
  }

  async createSession(data: Omit<SessionData, 'createdAt' | 'expiresAt'>): Promise<CreatedSession> {
    const sessionId = `${SESSION_ID_PREFIX}${randomBytes(32).toString('hex')}`;
    const createdAt = Date.now();
    const session: SessionData = { ...data, createdAt, expiresAt: createdAt + SESSION_TTL_SECONDS * 1000 };
    const client = await this.getRedisClient();
    if (client) await client.setEx(sessionKey(sessionId), SESSION_TTL_SECONDS, JSON.stringify(session));
    else this.sessions.set(sessionKey(sessionId), session);
    return { sessionId, expiresAt: session.expiresAt };
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
