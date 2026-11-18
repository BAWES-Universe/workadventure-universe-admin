const transaction = jest.fn();
jest.mock('@/lib/db', () => ({ prisma: { $transaction: (...args: unknown[]) => transaction(...args), appSetting: { findUnique: jest.fn() } } }));

import { getCodeJobPause, pauseCodeJobs } from '@/lib/workbench/state';

describe('the pause of code jobs', () => {
  beforeEach(() => {
    transaction.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('fails when the pause cannot be read while it is being written, instead of calling it already paused and writing nothing', async () => {
    const upsert = jest.fn();
    transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        $executeRaw: async () => 1,
        appSetting: { findUnique: async () => Promise.reject(new Error('statement timeout')), upsert },
      })
    );
    await expect(pauseCodeJobs('provider_ran_tools')).rejects.toThrow('statement timeout');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('writes the pause when it was not paused, and leaves the first reason when it already is', async () => {
    const upsert = jest.fn();
    const saved: { value: unknown } = { value: { paused: false } };
    transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        $executeRaw: async () => 1,
        appSetting: { findUnique: async () => ({ value: saved.value }), upsert },
      })
    );
    expect(await pauseCodeJobs('provider_ran_tools')).toMatchObject({ paused: true, reason: 'provider_ran_tools' });
    expect(upsert).toHaveBeenCalledTimes(1);
    saved.value = { paused: true, reason: 'manual', at: '2026-11-18T10:00:00.000Z' };
    expect(await pauseCodeJobs('provider_ran_tools')).toEqual({ paused: true, reason: 'manual', at: '2026-11-18T10:00:00.000Z' });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('still reads an unreadable pause as paused for admission, where nothing may start on a guess', async () => {
    const db = { appSetting: { findUnique: async () => Promise.reject(new Error('down')) } } as never;
    expect(await getCodeJobPause(db)).toEqual({ paused: true, reason: 'unreadable', at: null });
  });
});
