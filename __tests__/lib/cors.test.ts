import { NextRequest } from 'next/server';
import { corsHeaders } from '@/lib/cors';
import { getPlayOrigin, isAllowedOrigin, getAllowedOrigins } from '@/lib/origin-policy';
import { OPTIONS as botsOptions } from '@/app/api/bots/route';
import { OPTIONS as oauthDiscoverOptions } from '@/app/api/mcp/oauth-discover/route';
import fs from 'fs';
import path from 'path';

describe('CORS Origin Contract (SHU-0024 & Issue #171)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('corsHeaders helper', () => {
    it('grants CORS only to configured NEXT_PUBLIC_PLAY_URL', () => {
      process.env.NEXT_PUBLIC_PLAY_URL = 'https://play.workadventure.example.com';

      const req = new NextRequest('https://admin.example.com/api/bots', {
        headers: { Origin: 'https://play.workadventure.example.com' },
      });

      const headers = corsHeaders(req);
      expect(headers['Access-Control-Allow-Origin']).toBe('https://play.workadventure.example.com');
      expect(headers['Vary']).toBe('Origin');
      expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
      expect(headers['Access-Control-Allow-Methods']).toContain('GET');
      expect(headers['Access-Control-Allow-Methods']).toContain('POST');
      expect(headers['Access-Control-Allow-Methods']).toContain('OPTIONS');
      expect(headers['Access-Control-Allow-Methods']).toContain('PATCH');
      expect(headers['Access-Control-Allow-Headers']).toContain('Authorization');
    });

    it('denies CORS grant to unknown origins', () => {
      process.env.NEXT_PUBLIC_PLAY_URL = 'https://play.workadventure.example.com';

      const req = new NextRequest('https://admin.example.com/api/bots', {
        headers: { Origin: 'https://malicious-site.attacker.com' },
      });

      const headers = corsHeaders(req);
      expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
      expect(headers['Vary']).toBe('Origin');
      expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
    });

    it('denies CORS grant when Origin header is missing or empty', () => {
      process.env.NEXT_PUBLIC_PLAY_URL = 'https://play.workadventure.example.com';

      const req = new NextRequest('https://admin.example.com/api/bots');
      const headers = corsHeaders(req);
      expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
      expect(headers['Vary']).toBe('Origin');
      expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
    });

    it('denies CORS grant when called with no request (empty argument)', () => {
      process.env.NEXT_PUBLIC_PLAY_URL = 'https://play.workadventure.example.com';

      const headers = corsHeaders();
      expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
      expect(headers['Vary']).toBe('Origin');
      expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
    });

    it('never emits wildcard (*) or Access-Control-Allow-Credentials', () => {
      process.env.NEXT_PUBLIC_PLAY_URL = 'https://play.workadventure.example.com';

      const origins = [
        'https://play.workadventure.example.com',
        'https://evil.com',
        'http://localhost:3000',
        '*',
        '',
      ];

      for (const origin of origins) {
        const req = new NextRequest('https://admin.example.com/api/bots', {
          headers: origin ? { Origin: origin } : {},
        });
        const headers = corsHeaders(req);
        expect(headers['Access-Control-Allow-Origin']).not.toBe('*');
        expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
        expect(headers['Vary']).toBe('Origin');
      }
    });

    it('uses local play origin default in development when NEXT_PUBLIC_PLAY_URL is unset', () => {
      delete process.env.NEXT_PUBLIC_PLAY_URL;
      (process.env as any).NODE_ENV = 'development';

      const allowedReq = new NextRequest('http://admin.workadventure.localhost/api/bots', {
        headers: { Origin: 'http://play.workadventure.localhost' },
      });
      const deniedReq = new NextRequest('http://admin.workadventure.localhost/api/bots', {
        headers: { Origin: 'http://evil.localhost' },
      });

      expect(corsHeaders(allowedReq)['Access-Control-Allow-Origin']).toBe('http://play.workadventure.localhost');
      expect(corsHeaders(deniedReq)['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('shares the exact same origin allowlist as lib/origin-policy.ts', () => {
      process.env.NEXT_PUBLIC_PLAY_URL = 'https://play.staging.example.com';
      expect(isAllowedOrigin('https://play.staging.example.com')).toBe(true);
      expect(isAllowedOrigin('https://other.example.com')).toBe(false);
      expect(getAllowedOrigins()).toEqual(['https://play.staging.example.com']);
      expect(getPlayOrigin()).toBe('https://play.staging.example.com');
    });
  });

  describe('Route preflight integration', () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_PLAY_URL = 'https://play.workadventure.example.com';
    });

    it('/api/bots OPTIONS preflight grants allowed play origin and denies unknown origin', async () => {
      const allowedReq = new NextRequest('https://admin.example.com/api/bots', {
        method: 'OPTIONS',
        headers: { Origin: 'https://play.workadventure.example.com' },
      });
      const allowedRes = await botsOptions(allowedReq);
      expect(allowedRes.headers.get('access-control-allow-origin')).toBe('https://play.workadventure.example.com');
      expect(allowedRes.headers.get('access-control-allow-credentials')).toBeNull();
      expect(allowedRes.headers.get('vary')).toContain('Origin');

      const deniedReq = new NextRequest('https://admin.example.com/api/bots', {
        method: 'OPTIONS',
        headers: { Origin: 'https://attacker.com' },
      });
      const deniedRes = await botsOptions(deniedReq);
      expect(deniedRes.headers.get('access-control-allow-origin')).toBeNull();
      expect(deniedRes.headers.get('access-control-allow-credentials')).toBeNull();
      expect(deniedRes.headers.get('vary')).toContain('Origin');
    });

    it('/api/mcp/oauth-discover OPTIONS preflight grants allowed play origin and denies unknown origin', async () => {
      const allowedReq = new NextRequest('https://admin.example.com/api/mcp/oauth-discover', {
        method: 'OPTIONS',
        headers: { Origin: 'https://play.workadventure.example.com' },
      });
      const allowedRes = await oauthDiscoverOptions(allowedReq);
      expect(allowedRes.headers.get('access-control-allow-origin')).toBe('https://play.workadventure.example.com');
      expect(allowedRes.headers.get('access-control-allow-credentials')).toBeNull();
      expect(allowedRes.headers.get('vary')).toContain('Origin');

      const deniedReq = new NextRequest('https://admin.example.com/api/mcp/oauth-discover', {
        method: 'OPTIONS',
        headers: { Origin: 'https://attacker.com' },
      });
      const deniedRes = await oauthDiscoverOptions(deniedReq);
      expect(deniedRes.headers.get('access-control-allow-origin')).toBeNull();
      expect(deniedRes.headers.get('access-control-allow-credentials')).toBeNull();
      expect(deniedRes.headers.get('vary')).toContain('Origin');
    });
  });

  describe('Architectural contract audit: no local helpers or wildcards', () => {
    function getAllRouteFiles(dir: string): string[] {
      const results: string[] = [];
      const list = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of list) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...getAllRouteFiles(fullPath));
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
          results.push(fullPath);
        }
      }
      return results;
    }

    const appApiDir = path.resolve(process.cwd(), 'app/api');
    const routeFiles = getAllRouteFiles(appApiDir);

    it('asserts that no route defines a local corsHeaders function', () => {
      const offendingFiles: string[] = [];
      for (const file of routeFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        if (/function\s+corsHeaders\b/.test(content)) {
          offendingFiles.push(path.relative(process.cwd(), file));
        }
      }
      expect(offendingFiles).toEqual([]);
    });

    it('asserts that no route emits wildcard origin (Access-Control-Allow-Origin: *)', () => {
      const offendingFiles: string[] = [];
      for (const file of routeFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        if (/Access-Control-Allow-Origin['"]?\s*:\s*['"]\*/.test(content)) {
          offendingFiles.push(path.relative(process.cwd(), file));
        }
      }
      expect(offendingFiles).toEqual([]);
    });

    it('asserts that no route emits Access-Control-Allow-Credentials', () => {
      const offendingFiles: string[] = [];
      for (const file of routeFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        if (/Access-Control-Allow-Credentials/.test(content)) {
          offendingFiles.push(path.relative(process.cwd(), file));
        }
      }
      expect(offendingFiles).toEqual([]);
    });
  });
});
