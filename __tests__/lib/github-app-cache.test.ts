/**
 * Universe's GitHub App is kept for a minute on each server. Forgetting it (right after it is saved, or when another server may have
 * changed it) must hold even for a read that began before: its older answer never goes back into the copy.
 */
const readSetting = jest.fn();
jest.mock('@/lib/db', () => ({ prisma: { appSetting: { findUnique: (...args: unknown[]) => readSetting(...args) } } }));
jest.mock('@/lib/encryption', () => ({ decryptApiKey: (value: string) => value, encryptApiKey: (value: string) => value }));

import { forgetGitHubApp, getGitHubApp } from '@/lib/github/app';

const stored = (appId: number) => ({
  value: { appId, slug: `app-${appId}`, clientId: `c${appId}`, htmlUrl: `https://github.com/apps/app-${appId}`, secrets: JSON.stringify({ clientSecret: 's', pem: 'p' }) },
});

beforeEach(() => {
  readSetting.mockReset();
  forgetGitHubApp();
});

describe('the GitHub App kept for a minute', () => {
  it('answers from the copy until it is forgotten', async () => {
    readSetting.mockResolvedValue(stored(1));
    expect((await getGitHubApp())?.appId).toBe(1);
    readSetting.mockResolvedValue(stored(2));
    expect((await getGitHubApp())?.appId).toBe(1);
    forgetGitHubApp();
    expect((await getGitHubApp())?.appId).toBe(2);
  });

  it('never lets a read that began before a forgetting put its older answer back', async () => {
    let finishOld: (value: unknown) => void = () => undefined;
    readSetting.mockImplementationOnce(() => new Promise((resolve) => (finishOld = resolve)));
    const oldRead = getGitHubApp();
    // The app is replaced and forgotten while that read is still out
    forgetGitHubApp();
    finishOld(stored(1));
    expect((await oldRead)?.appId).toBe(1);
    // Nothing old was kept: the next call reads the store again
    readSetting.mockResolvedValue(stored(2));
    expect((await getGitHubApp())?.appId).toBe(2);
  });
});
