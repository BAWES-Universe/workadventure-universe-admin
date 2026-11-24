/**
 * A pretend worker that took a row lock, did its part and DIED before committing: the transaction is rolled back by throwing this. Only this error is swallowed by
 * `afterWorkerDied`; any other error thrown inside (a failed assertion made while the lock was held) reaches the test.
 */
export class WorkerDied extends Error {
  constructor() {
    super('the worker died');
    this.name = 'WorkerDied';
  }
}

export const afterWorkerDied = (transaction: Promise<unknown>): Promise<void> =>
  transaction.then(
    () => undefined,
    (error: unknown) => {
      if (!(error instanceof WorkerDied)) throw error;
    },
  );
