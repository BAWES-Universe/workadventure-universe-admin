/**
 * The database suites share one database and one `instant-limits` row: with ROLES_DB_TEST set, jest runs them with a single worker, whatever command starts it.
 *
 * Hermetic on purpose: jest.config.js is loaded with a PRETEND `next/jest`. The real one loads and transpiles next.config.ts on the fly, from inside jest's own sandbox here, and that
 * depends on the machine (a clean CI checkout fails with "Cannot find module './lib/origin-policy'" where a developer's machine passes). What is tested is jest.config.js's own part:
 * when it reads the flag.
 */
describe('database suites run one at a time', () => {
  /**
   * Loads jest.config.js with a pretend next/jest and returns the config it builds. `flag` is the flag in the environment when the file is read; `loaderSets` is a flag the
   * pretend loader puts in the environment while it builds the config (what loading .env.test does).
   */
  const configWith = async (flag: string | undefined, loaderSets?: string) => {
    const before = process.env.ROLES_DB_TEST;
    if (flag === undefined) delete process.env.ROLES_DB_TEST;
    else process.env.ROLES_DB_TEST = flag;
    try {
      let loaded: () => Promise<{ maxWorkers?: number }> = async () => ({});
      jest.isolateModules(() => {
        jest.doMock('next/jest', () => () => (custom: object) => async () => {
          if (loaderSets !== undefined) process.env.ROLES_DB_TEST = loaderSets;
          return { ...custom };
        });
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- the config is a CommonJS file read fresh under each setting of the flag
        loaded = require('../../jest.config.js');
      });
      expect(process.env.ROLES_DB_TEST).toBe(flag);
      return await loaded();
    } finally {
      jest.dontMock('next/jest');
      if (before === undefined) delete process.env.ROLES_DB_TEST;
      else process.env.ROLES_DB_TEST = before;
    }
  };

  it('uses one worker when the database suites are on, and leaves the rest to jest when they are off', async () => {
    expect((await configWith('yes')).maxWorkers).toBe(1);
    expect((await configWith(undefined)).maxWorkers).toBeUndefined();
  });

  it('reads the flag after next/jest has loaded the .env files: the flag is set by the loader itself, right before it returns, never before', async () => {
    expect((await configWith(undefined, 'yes')).maxWorkers).toBe(1);
  });
});
