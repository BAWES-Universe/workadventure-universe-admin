/** The database suites share one database and one `instant-limits` row: with ROLES_DB_TEST set, jest runs them with a single worker, whatever command starts it. */
describe('database suites run one at a time', () => {
  const configWith = async (flag: string | undefined) => {
    const before = process.env.ROLES_DB_TEST;
    if (flag === undefined) delete process.env.ROLES_DB_TEST;
    else process.env.ROLES_DB_TEST = flag;
    try {
      let loaded: () => Promise<{ maxWorkers?: number }> = async () => ({});
      jest.isolateModules(() => {
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
});
