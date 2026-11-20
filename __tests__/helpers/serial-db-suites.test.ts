/** The database suites share one database and one `instant-limits` row: with ROLES_DB_TEST set, jest runs them with a single worker, whatever command starts it. */
describe('database suites run one at a time', () => {
  const configWith = async (flag: string | undefined) => {
    const before = process.env.ROLES_DB_TEST;
    if (flag === undefined) delete process.env.ROLES_DB_TEST;
    else process.env.ROLES_DB_TEST = flag;
    try {
      let loaded: () => Promise<{ maxWorkers?: number }> = async () => ({});
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- the config is a CommonJS file read fresh under each setting of the flag
        loaded = require('../../jest.config.js');
      });
      return await loaded();
    } finally {
      if (before === undefined) delete process.env.ROLES_DB_TEST;
      else process.env.ROLES_DB_TEST = before;
    }
  };

  it('uses one worker when the database suites are on, and leaves the rest to jest when they are off', async () => {
    expect((await configWith('yes')).maxWorkers).toBe(1);
    expect((await configWith(undefined)).maxWorkers).toBeUndefined();
  });

  it('reads the flag after next/jest has loaded the .env files: the flag is set by the loader itself, right before it returns, never before', async () => {
    const before = process.env.ROLES_DB_TEST;
    try {
      delete process.env.ROLES_DB_TEST;
      let loaded: () => Promise<{ maxWorkers?: number }> = async () => ({});
      jest.isolateModules(() => {
        // next/jest loads the .env files when its config is BUILT: the pretend one sets the flag there, as a flag in .env.test would be, and returns
        jest.doMock('next/jest', () => () => (custom: object) => async () => {
          process.env.ROLES_DB_TEST = 'yes';
          return { ...custom };
        });
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- the config is a CommonJS file read fresh
        loaded = require('../../jest.config.js');
      });
      expect(process.env.ROLES_DB_TEST).toBeUndefined();
      expect((await loaded()).maxWorkers).toBe(1);
    } finally {
      jest.dontMock('next/jest');
      if (before === undefined) delete process.env.ROLES_DB_TEST;
      else process.env.ROLES_DB_TEST = before;
    }
  });
});
