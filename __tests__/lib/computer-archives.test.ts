jest.mock('@/lib/db', () => ({ prisma: {} }));

import { DOWNLOAD_LIFE_MS, downloadUrl, mintDownloadToken, verifyDownloadToken } from '@/lib/computer-archives';

beforeAll(() => {
  process.env.ENCRYPTION_KEY ||= 'cd'.repeat(32);
});

describe('the key a computer restores a copy with', () => {
  const now = Date.UTC(2026, 10, 17, 12);

  it('works for the copy and the computer it was made for, and says which computer', () => {
    const token = mintDownloadToken('archive-1', 'machine-9', now);
    expect(verifyDownloadToken(token, 'archive-1', now + 60_000)).toEqual({ ref: 'machine-9' });
    // A restore that is retried uses the same key
    expect(verifyDownloadToken(token, 'archive-1', now + 30 * 60_000)).toEqual({ ref: 'machine-9' });
  });

  it('does not work for another copy, after it runs out, or when it was changed', () => {
    const token = mintDownloadToken('archive-1', 'machine-9', now);
    expect(verifyDownloadToken(token, 'archive-2', now)).toBeNull();
    expect(verifyDownloadToken(token, 'archive-1', now + DOWNLOAD_LIFE_MS + 1000)).toBeNull();
    const [expires, ref, mac] = token.split('.');
    expect(verifyDownloadToken(`${expires}.${Buffer.from('machine-10').toString('base64url')}.${mac}`, 'archive-1', now)).toBeNull();
    expect(verifyDownloadToken(`${Number(expires) + 100000}.${ref}.${mac}`, 'archive-1', now)).toBeNull();
    expect(verifyDownloadToken(`${expires}.${ref}.${mac.slice(0, -2)}AA`, 'archive-1', now)).toBeNull();
  });

  it('does not work when it is empty, malformed, or made far in the future', () => {
    for (const bad of [null, undefined, '', 'x', 'a.b', 'a.b.c.d', '1.2.3']) expect(verifyDownloadToken(bad, 'archive-1', now)).toBeNull();
    expect(verifyDownloadToken(mintDownloadToken('archive-1', 'm', now + 10 * DOWNLOAD_LIFE_MS), 'archive-1', now)).toBeNull();
  });

  it('is fetched from Orbit’s own public address, with no new setting', () => {
    expect(downloadUrl('a/b', { ADMIN_API_URL: 'https://orbit.example.com/' } as unknown as NodeJS.ProcessEnv)).toBe('https://orbit.example.com/api/computer/archives/a%2Fb/download');
    expect(downloadUrl('a', { NEXT_PUBLIC_API_URL: 'https://x.example', ADMIN_API_URL: 'https://y.example' } as unknown as NodeJS.ProcessEnv)).toBe('https://x.example/api/computer/archives/a/download');
    expect(downloadUrl('a', {} as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});
