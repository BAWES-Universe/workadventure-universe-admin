import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { allowedOrigins, corsHeaders } from '@/lib/cors';

const requestFrom = (origin: string | null) => new Request('https://orbit.example/api/bots', origin ? { headers: { origin } } : {});

describe('corsHeaders', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = 'https://orbit.example';
    process.env.NEXT_PUBLIC_PLAY_URL = 'https://play.example';
    delete process.env.CORS_ALLOWED_ORIGINS;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("echoes Orbit's own origin and the game's origin, with Vary: Origin and no credentials", () => {
    for (const origin of ['https://orbit.example', 'https://play.example']) {
      const headers = corsHeaders(requestFrom(origin));
      expect(headers['Access-Control-Allow-Origin']).toBe(origin);
      expect(headers.Vary).toBe('Origin');
      expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
    }
  });

  it('gives no grant to any other origin, and never *', () => {
    const headers = corsHeaders(requestFrom('https://evil.example'));
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers.Vary).toBe('Origin');
    expect(Object.values(headers)).not.toContain('*');
    expect(corsHeaders(requestFrom(null))['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('adds the origins in CORS_ALLOWED_ORIGINS, even with spaces after the commas', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://a.example, https://b.example ,';
    expect(allowedOrigins(requestFrom(null))).toEqual(['https://orbit.example', 'https://play.example', 'https://a.example', 'https://b.example']);
    expect(corsHeaders(requestFrom('https://b.example'))['Access-Control-Allow-Origin']).toBe('https://b.example');
  });

  it('takes the methods a route allows', () => {
    expect(corsHeaders(requestFrom('https://play.example'), 'GET, OPTIONS')['Access-Control-Allow-Methods']).toBe('GET, OPTIONS');
  });
});

describe('one CORS rule for every route (#171)', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) files.push(path);
    }
  };
  walk(join(__dirname, '../../app'));
  walk(join(__dirname, '../../lib'));

  const grantsAnyone = /['"]Access-Control-Allow-Origin['"]\s*[\]:,]\s*(?:=\s*)?['"]\*['"]/g;
  /**
   * The one file that may answer `*`: the songs, images and videos of a private artifact (game #1994), read by a locked
   * page that has no origin to name. They are protected by the pass in their address and read no sign-in or cookie
   * (lib/artifact-pass.ts, MEDIA_READ_HEADERS).
   */
  const privateMedia = join('lib', 'artifact-pass.ts');

  it('has no route that grants * or credentials, or keeps its own corsHeaders', () => {
    const offenders = files.filter((path) => {
      const source = readFileSync(path, 'utf8');
      return (
        (source.match(grantsAnyone) !== null && !path.endsWith(privateMedia)) ||
        /Access-Control-Allow-Credentials['"]\s*[\]:,]/.test(source) ||
        (/function corsHeaders\s*\(/.test(source) && !path.endsWith(join('lib', 'cors.ts')))
      );
    });
    expect(offenders).toEqual([]);
  });

  it('answers * in one place only: the media of a private artifact, which no cookie opens', () => {
    const source = readFileSync(join(__dirname, '../..', privateMedia), 'utf8');
    expect(source.match(grantsAnyone)).toHaveLength(1);
    expect(source).toMatch(/export const MEDIA_READ_HEADERS = \{ 'Access-Control-Allow-Origin': '\*'/);
    // Used by the one function that serves those files, and nowhere else
    const users = files.filter((path) => !path.endsWith(privateMedia) && readFileSync(path, 'utf8').includes('MEDIA_READ_HEADERS'));
    expect(users).toEqual([join(__dirname, '../../lib/artifact-service.ts')]);
    expect(readFileSync(users[0], 'utf8').match(/\.\.\.MEDIA_READ_HEADERS/g)).toHaveLength(1);
  });
});
