/**
 * The small parts a private artifact's address is made of (game #1994, lib/artifact-pass.ts): the secret and what is
 * kept of it, the address and its cookie, the lock a private page is sent with, and the part of a file a player asks for.
 */
import { ArtifactError } from '@/lib/artifacts';
import {
  MEDIA_POLICY,
  drawingPolicy,
  hashOf,
  looksLikeSecret,
  mayShowPage,
  newSecret,
  orbitAddress,
  pagePolicy,
  parseRange,
  passAddress,
  passCookie,
  passCookieValue,
  passFolderAddress,
  passCookieName,
  passFolder,
  passLifeMs,
  readCookie,
  sameHash,
} from '@/lib/artifact-pass';

const ENV = ['NEXT_PUBLIC_API_URL', 'ADMIN_API_URL', 'ARTIFACT_PASS_MINUTES', 'NEXT_PUBLIC_PLAY_URL', 'PLAY_URL'] as const;
const before = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://orbit.example.test';
  delete process.env.ADMIN_API_URL;
  delete process.env.ARTIFACT_PASS_MINUTES;
  process.env.NEXT_PUBLIC_PLAY_URL = 'https://play.example.test';
});

afterAll(() => {
  for (const key of ENV) {
    if (before[key] === undefined) delete process.env[key];
    else process.env[key] = before[key];
  }
});

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof ArtifactError ? `${error.code}:${error.status}` : 'other';
  }
  return undefined;
}

describe('the secret in an address', () => {
  it('is 256 random bits in letters a path and a cookie can hold, new every time', () => {
    const one = newSecret();
    const two = newSecret();
    expect(one).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(one, 'base64url')).toHaveLength(32);
    expect(two).not.toBe(one);
  });

  it('is kept only as its SHA-256', () => {
    expect(hashOf('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashOf(newSecret())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is compared whole: equal hashes match, anything else does not', () => {
    expect(sameHash(hashOf('a'), hashOf('a'))).toBe(true);
    expect(sameHash(hashOf('a'), hashOf('b'))).toBe(false);
    expect(sameHash(hashOf('a'), hashOf('a').slice(0, 10))).toBe(false);
    expect(sameHash('', hashOf('a'))).toBe(false);
  });

  it('is only looked up when it has the shape of one', () => {
    expect(looksLikeSecret(newSecret())).toBe(true);
    for (const value of [undefined, null, '', 'short', `${newSecret()}x`, newSecret().replace(/.$/, '/'), '../../etc/passwd', 'a'.repeat(42), 'a'.repeat(44)]) {
      expect(looksLikeSecret(value)).toBe(false);
    }
  });
});

describe('how long one opening lasts', () => {
  it('is twelve hours unless the server says otherwise', () => {
    expect(passLifeMs()).toBe(12 * 60 * 60_000);
    process.env.ARTIFACT_PASS_MINUTES = '30';
    expect(passLifeMs()).toBe(30 * 60_000);
  });

  it('falls back to twelve hours for a setting that is no number of minutes', () => {
    for (const value of ['', 'soon', '0', '-5', 'NaN', 'Infinity']) {
      process.env.ARTIFACT_PASS_MINUTES = value;
      expect(passLifeMs()).toBe(12 * 60 * 60_000);
    }
  });
});

describe('the address', () => {
  it('is on Orbit, under the pass and the version, with the page named by its kind', () => {
    expect(passFolder('TOKEN', 3)).toBe('/af/TOKEN/3/');
    expect(passAddress('TOKEN', 3, 'page')).toBe('https://orbit.example.test/af/TOKEN/3/index.html');
    expect(passAddress('TOKEN', 1, 'app')).toBe('https://orbit.example.test/af/TOKEN/1/index.html');
    expect(passAddress('TOKEN', 2, 'svg')).toBe('https://orbit.example.test/af/TOKEN/2/index.svg');
    expect(passFolderAddress('TOKEN', 3)).toBe('https://orbit.example.test/af/TOKEN/3/');
  });

  it('uses the address a browser reaches Orbit at, without a trailing slash', () => {
    process.env.NEXT_PUBLIC_API_URL = ' https://orbit.example.test/// ';
    expect(orbitAddress()).toBe('https://orbit.example.test');
    delete process.env.NEXT_PUBLIC_API_URL;
    process.env.ADMIN_API_URL = 'http://localhost:3333/';
    expect(orbitAddress()).toBe('http://localhost:3333');
  });

  it('is refused with a 503 when Orbit does not know its own address, so nothing is made private half way', () => {
    for (const value of [undefined, '', 'orbit.example.test', '/relative']) {
      if (value === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = value;
      expect(codeOf(() => orbitAddress())).toBe('private_files_not_configured:503');
      expect(codeOf(() => passAddress('TOKEN', 1, 'page'))).toBe('private_files_not_configured:503');
    }
  });
});

describe('the cookie that ties a pass to the browser that opened it', () => {
  it('has a name that says nothing, from the stored hash', () => {
    expect(passCookieName('0123456789abcdef0123')).toBe('af_0123456789ab');
  });

  it('is read only by this pass’s own addresses, never by scripts, and sent from the locked frame over https', () => {
    const cookie = passCookie('TOKEN', '0123456789abcdef', 'VALUE', 600.9);
    expect(cookie.split('; ')).toEqual(['af_0123456789ab=VALUE', 'Path=/af/TOKEN/', 'Max-Age=600', 'HttpOnly', 'Secure', 'SameSite=None']);
    expect(cookie).not.toMatch(/Partitioned/i);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('is Lax on plain http, where SameSite=None cannot be set', () => {
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:3333';
    expect(passCookie('TOKEN', '0123456789abcdef', 'VALUE', 60)).toBe('af_0123456789ab=VALUE; Path=/af/TOKEN/; Max-Age=60; HttpOnly; SameSite=Lax');
  });

  it('never lasts less than a second', () => {
    expect(passCookie('T', '0123456789abcdef', 'V', 0)).toContain('Max-Age=1;');
    expect(passCookie('T', '0123456789abcdef', 'V', -30)).toContain('Max-Age=1;');
  });

  it('is found in a Cookie header by its exact name', () => {
    const header = 'theme=dark; af_0123456789ab=VALUE ; af_0123456789abX=other; empty=';
    expect(readCookie(header, 'af_0123456789ab')).toBe('VALUE');
    expect(readCookie(header, 'af_0123456789abX')).toBe('other');
    expect(readCookie(header, 'empty')).toBe('');
    expect(readCookie(header, 'af_0123')).toBeNull();
    expect(readCookie(header, 'missing')).toBeNull();
    expect(readCookie(null, 'af_0123456789ab')).toBeNull();
    expect(readCookie('', 'af_0123456789ab')).toBeNull();
    expect(readCookie('a=b=c', 'a')).toBe('b=c');
  });
});

describe('the one cookie of a pass', () => {
  const token = newSecret();
  const passId = '3f0e8c1a-6a2b-4d57-9a41-0d7c2b9e5f10';

  it('is the same however often it is made, so of two answers to one browser it does not matter which arrives last', () => {
    expect(passCookieValue(token, passId)).toBe(passCookieValue(token, passId));
  });

  it('is made of the address and of the pass\'s own id: another address or another pass has another one', () => {
    expect(passCookieValue(newSecret(), passId)).not.toBe(passCookieValue(token, passId));
    expect(passCookieValue(token, '9b1d4e7c-0f3a-4c68-8e52-6a7d1c3b2f44')).not.toBe(passCookieValue(token, passId));
  });

  it('is as long and as plain as any secret here, and is neither of the two things it is made of', () => {
    const cookie = passCookieValue(token, passId);
    expect(looksLikeSecret(cookie)).toBe(true);
    expect(cookie).not.toBe(token);
    expect(cookie).not.toContain(passId);
    // What the table keeps of the address does not make it either
    expect(passCookieValue(hashOf(token), passId)).not.toBe(cookie);
  });
});

describe('the lock a private file is sent with', () => {
  it('runs a page with no origin, no network but the common libraries, no forms, framed only by the game and Orbit', () => {
    const policy = pagePolicy(passFolderAddress('TOKEN', 3)).split('; ');
    expect(policy).toContain('sandbox allow-scripts');
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("frame-ancestors 'self' https://play.example.test");
    expect(policy.join('; ')).not.toMatch(/allow-same-origin|allow-forms|allow-top-navigation|allow-popups/);
  });

  it('lets a page load pictures, songs and videos from its own folder only, never from the rest of Orbit', () => {
    expect(passFolderAddress('TOKEN', 3)).toBe('https://orbit.example.test/af/TOKEN/3/');
    const policy = pagePolicy(passFolderAddress('TOKEN', 3)).split('; ');
    expect(policy).toContain('img-src https://orbit.example.test/af/TOKEN/3/ data: blob:');
    expect(policy).toContain('media-src https://orbit.example.test/af/TOKEN/3/ data: blob:');
    // 'self' would be all of Orbit: it stays only where it says who may frame the page
    expect(policy.filter((part) => part.includes("'self'"))).toEqual(["frame-ancestors 'self' https://play.example.test"]);
    expect(policy.filter((part) => /^(img|media|script|style|font|connect|default)-src/.test(part)).join(' ')).not.toContain('https://orbit.example.test ');
  });

  it('never runs anything in a drawing, and nothing at all in a song, image or video opened on its own', () => {
    expect(drawingPolicy().split('; ')).toEqual(['sandbox', "default-src 'none'", "style-src 'unsafe-inline'", 'img-src data:', "frame-ancestors 'self' https://play.example.test"]);
    expect(MEDIA_POLICY).toBe("sandbox; default-src 'none'");
  });

  it('shows a page only inside a frame: a browser that says it is opening a tab is turned away', () => {
    expect(mayShowPage('iframe')).toBe(true);
    expect(mayShowPage('frame')).toBe(true);
    // An old browser says nothing; the lock above still holds there
    expect(mayShowPage(null)).toBe(true);
    expect(mayShowPage(undefined)).toBe(true);
    for (const dest of ['document', 'image', 'script', 'empty', 'embed', 'object', 'audio', 'video']) expect(mayShowPage(dest)).toBe(false);
  });
});

describe('one part of a file, as a player asks while it seeks', () => {
  it('reads the three shapes a browser sends', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=100-', 1000)).toEqual({ start: 100, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange(' bytes=0-0 ', 1000)).toEqual({ start: 0, end: 0 });
  });

  it('stops at the end of the file', () => {
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('serves the whole file when no part is asked for, or the header is not one it reads', () => {
    for (const header of [null, undefined, '', 'bytes=-', 'bytes=a-b', 'items=0-5', 'bytes=0-5,10-15', 'bytes=5']) expect(parseRange(header, 1000)).toBeNull();
  });

  it('says so when the part is not in the file', () => {
    for (const header of ['bytes=1000-', 'bytes=1000-1001', 'bytes=50-10', 'bytes=-0', 'bytes=99999999999999999999-']) expect(parseRange(header, 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-10', 0)).toBe('unsatisfiable');
  });
});
