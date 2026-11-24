import { ownVersionFor, whyNotReady } from '@/lib/app-routes/own-versions';

describe('the list of own versions', () => {
  it('finds only its own entries, never something inherited from Object', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(ownVersionFor(key)).toBeNull();
      expect(whyNotReady(key)).toEqual(['We have no version of our own for this App yet.']);
    }
  });
});
