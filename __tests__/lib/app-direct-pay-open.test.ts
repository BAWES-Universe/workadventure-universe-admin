const mockFind = jest.fn();
jest.mock('@/lib/db', () => ({ prisma: { artifact: { findUnique: (...args: unknown[]) => mockFind(...args) } } }));
jest.mock('@/lib/app-direct/catalog', () => jest.requireActual('../helpers/example-gateway').catalogWithExample());

import { isOpenByLink } from '@/lib/app-direct/pay';

/** The public page's checkout is only for a page a visitor can see (game #2115). */
describe('isOpenByLink', () => {
  const row = (over: object) => mockFind.mockResolvedValue({ openScope: 'link', publishedVersion: null, expiresAt: null, ...over });

  it('is yes for a link, published or not', async () => {
    row({});
    await expect(isOpenByLink('a')).resolves.toBe(true);
    row({ publishedVersion: 2 });
    await expect(isOpenByLink('a')).resolves.toBe(true);
  });

  it('is yes for Public only once a version is published, so nobody pays on a page they cannot see', async () => {
    row({ openScope: 'public' });
    await expect(isOpenByLink('a')).resolves.toBe(false);
    row({ openScope: 'public', publishedVersion: 1 });
    await expect(isOpenByLink('a')).resolves.toBe(true);
  });

  it('is no for a page only for its chat or private, one that ran out, or one that is not there', async () => {
    row({ openScope: 'chat', publishedVersion: 1 });
    await expect(isOpenByLink('a')).resolves.toBe(false);
    row({ openScope: 'me' });
    await expect(isOpenByLink('a')).resolves.toBe(false);
    row({ expiresAt: new Date(Date.now() - 1000) });
    await expect(isOpenByLink('a')).resolves.toBe(false);
    mockFind.mockResolvedValue(null);
    await expect(isOpenByLink('a')).resolves.toBe(false);
  });
});
