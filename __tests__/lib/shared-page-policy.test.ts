import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { sharedPagePolicy } from '@/lib/shared-page-policy';

const sourcesOf = (policy: string, directive: string): string[] =>
  (policy.split(';').map((part) => part.trim().split(/\s+/)).find(([name]) => name === directive) ?? []).slice(1);

describe('the policy of the shared page', () => {
  it('is never framed, and its frames are its own or the address the files are served from', () => {
    const policy = sharedPagePolicy('https://files.example/artifacts/');
    expect(sourcesOf(policy, 'frame-ancestors')).toEqual(["'none'"]);
    expect(sourcesOf(policy, 'frame-src')).toEqual(["'self'", 'https://files.example']);
  });

  it('allows the address a public Page is served from, as the storage gives it', () => {
    // ARTIFACTS_PUBLIC_URL with a path and a closing slash, and a version's file under it (artifactFiles.urlFor)
    const publicUrl = 'https://files.example/artifacts/';
    const pageAddress = `${publicUrl.replace(/\/+$/, '')}/a1/v2/index.html`;
    expect(sourcesOf(sharedPagePolicy(publicUrl), 'frame-src')).toContain(new URL(pageAddress).origin);
    // Another address is not allowed
    expect(sourcesOf(sharedPagePolicy(publicUrl), 'frame-src')).not.toContain('https://evil.example');
  });

  it('keeps to its own frames when no address is given or the address is not one', () => {
    expect(sourcesOf(sharedPagePolicy(''), 'frame-src')).toEqual(["'self'"]);
    expect(sourcesOf(sharedPagePolicy('not a url'), 'frame-src')).toEqual(["'self'"]);
  });

  it('is put on a shared page when the request comes in, from the address the running server has', () => {
    const before = process.env.ARTIFACTS_PUBLIC_URL;
    process.env.ARTIFACTS_PUBLIC_URL = 'https://runtime-files.example';
    try {
      const shared = middleware(new NextRequest('https://orbit.example/a/f9a68794-fe72-47c2-bc59-e65c6ce1d392'));
      expect(sourcesOf(shared.headers.get('content-security-policy') ?? '', 'frame-src')).toContain('https://runtime-files.example');
      // Not on any other page: they keep the policies they have
      const other = middleware(new NextRequest('https://orbit.example/admin/you'));
      expect(other.headers.get('content-security-policy')).toBeNull();
    } finally {
      if (before === undefined) delete process.env.ARTIFACTS_PUBLIC_URL;
      else process.env.ARTIFACTS_PUBLIC_URL = before;
    }
  });
});
