import crypto from 'crypto';

// Lazy-load Redis client to avoid Edge runtime issues
let redisClientModule: typeof import('redis') | null = null;

/**
 * Session store using Redis (with in-memory fallback)
 * Works across processes and in iframes
 */
interface SessionData {
  userId: string;
  uuid: string;
  email: string | null;
  name: string | null;
  tags: string[];
  createdAt: number;
  expiresAt: number;
}

class SessionStore {
  private redisClient: any = null; // Use any to avoid type issues with lazy loading
  private sessions: Map<string, SessionData> = new Map(); // Fallback in-memory store
  private readonly CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
  private redisInitialized = false;
  private redisInitPromise: Promise<void> | null = null;

  constructor() {
    // Don't initialize Redis in constructor - lazy load when needed
    // Clean up expired sessions periodically (for in-memory fallback)
    if (typeof setInterval !== 'undefined') {
      setInterval(() => this.cleanup(), this.CLEANUP_INTERVAL);
    }
  }

  /**
   * Lazy-load Redis client (only in Node.js runtime, not Edge)
   */
  private async getRedisClient() {
    // If already initialized, return it
    if (this.redisClient && this.redisInitialized) {
      return this.redisClient;
    }

    // If initialization is in progress, wait for it
    if (this.redisInitPromise) {
      await this.redisInitPromise;
      return this.redisClient;
    }

    // Start initialization
    this.redisInitPromise = this.initRedis();
    await this.redisInitPromise;
    return this.redisClient;
  }

  /**
   * Initialize Redis connection (only in Node.js runtime)
   */
  private async initRedis() {
    // Check if we're in Edge runtime (no Node.js modules available)
    try {
      // Try to detect Edge runtime - if crypto is not available as a module, we're in Edge
      if (typeof crypto === 'undefined' || !crypto.randomBytes) {
        if (process.env.NODE_ENV === 'development') {
          console.log('[SessionStore] Edge runtime detected, using in-memory store only');
        }
        return;
      }
    } catch {
      // If we can't check, assume we're in Node.js and continue
    }

    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      if (process.env.NODE_ENV === 'development') {
        console.log('[SessionStore] REDIS_URL not set, using in-memory store');
      }
      return;
    }

    try {
      // Lazy load Redis module only in Node.js runtime
      if (!redisClientModule) {
        redisClientModule = await import('redis');
      }

      const { createClient } = redisClientModule;
      this.redisClient = createClient({ url: redisUrl });
      
      this.redisClient.on('error', (err: Error) => {
        console.error('[SessionStore] Redis error:', err);
        this.redisClient = null;
        this.redisInitialized = false;
      });

      await this.redisClient.connect();
      this.redisInitialized = true;
      
      if (process.env.NODE_ENV === 'development') {
        console.log('[SessionStore] Redis connected successfully');
      }
    } catch (error) {
      console.error('[SessionStore] Failed to connect to Redis:', error);
      this.redisClient = null;
      this.redisInitialized = false;
    }
  }

  /**
   * Generate a secure random session ID
   */
  generateSessionId(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Create a new session
   */
  async createSession(data: Omit<SessionData, 'createdAt' | 'expiresAt'>): Promise<string> {
    const sessionId = this.generateSessionId();
    const now = Date.now();
    const expiresAt = now + (7 * 24 * 60 * 60 * 1000); // 7 days

    const sessionData: SessionData = {
      ...data,
      createdAt: now,
      expiresAt,
    };

    // Try to store in Redis if available (lazy load)
    try {
      const client = await this.getRedisClient();
      if (client && this.redisInitialized) {
        const ttl = Math.floor((expiresAt - now) / 1000); // TTL in seconds
        await client.setEx(
          `session:${sessionId}`,
          ttl,
          JSON.stringify(sessionData)
        );
        
        if (process.env.NODE_ENV === 'development') {
          console.log('[SessionStore] Created session in Redis:', sessionId.substring(0, 8) + '...', 'TTL:', ttl, 'seconds');
        }
        return sessionId;
      }
    } catch (error) {
      // Redis not available or failed, fall through to in-memory
      if (process.env.NODE_ENV === 'development') {
        console.log('[SessionStore] Redis not available, using in-memory:', error instanceof Error ? error.message : String(error));
      }
    }

    // Fallback to in-memory
    this.sessions.set(sessionId, sessionData);
    if (process.env.NODE_ENV === 'development') {
      console.log('[SessionStore] Created session in memory:', sessionId.substring(0, 8) + '...', 'Total sessions:', this.sessions.size);
    }

    return sessionId;
  }

  /**
   * Get session data by ID
   */
  async getSession(sessionId: string): Promise<SessionData | null> {
    // Try Redis first (lazy load)
    try {
      const client = await this.getRedisClient();
      if (client && this.redisInitialized) {
        const data = await client.get(`session:${sessionId}`);
        if (data) {
          const session = JSON.parse(data) as SessionData;
          
          // Check expiration
          if (Date.now() > session.expiresAt) {
            await this.deleteSession(sessionId);
            return null;
          }

          if (process.env.NODE_ENV === 'development') {
            console.log('[SessionStore] Session found in Redis for user:', session.userId);
          }

          return session;
        }
      }
    } catch (error) {
      // Redis not available or failed, fall through to in-memory
      if (process.env.NODE_ENV === 'development') {
        console.log('[SessionStore] Redis lookup failed, trying in-memory:', error instanceof Error ? error.message : String(error));
      }
    }

    // Fallback to in-memory
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      if (process.env.NODE_ENV === 'development') {
        console.log('[SessionStore] Session not found in memory:', sessionId.substring(0, 8) + '...');
      }
      return null;
    }

    // Check expiration
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      return null;
    }

    if (process.env.NODE_ENV === 'development') {
      console.log('[SessionStore] Session found in memory for user:', session.userId);
    }

    return session;
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    // Delete from Redis if available (lazy load)
    try {
      const client = await this.getRedisClient();
      if (client && this.redisInitialized) {
        await client.del(`session:${sessionId}`);
      }
    } catch (error) {
      // Redis not available, continue to delete from memory
      if (process.env.NODE_ENV === 'development') {
        console.log('[SessionStore] Redis delete failed, deleting from memory:', error instanceof Error ? error.message : String(error));
      }
    }
    
    // Delete from in-memory fallback
    this.sessions.delete(sessionId);
  }

  /**
   * Clean up expired sessions
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

// Singleton instance
export const sessionStore = new SessionStore();

