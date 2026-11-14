/** A Brick's computer (game #2000): the rules that need no database, and which provider a server runs. */
import { computerProviderKind, FakeComputerProvider } from '@/lib/computer-provider';
import { costOfSeconds, roomFor, isOver, PERSON_ONLY, AFTER_TAKE_OVER } from '@/lib/computer-values';

describe('what an awake machine costs', () => {
  it('is worked out from the seconds it was held, at the provider’s own price for a minute', () => {
    expect(costOfSeconds(300, 6000)).toBe(30_000);
    expect(costOfSeconds(1, 6000)).toBe(100);
    expect(costOfSeconds(0, 6000)).toBe(0);
  });

  it('is unknown, never 0, when the provider has not said what a minute costs', () => {
    expect(costOfSeconds(300, null)).toBeNull();
  });

  it('reserves room for the next stretch, at least a real amount even when the price is not known', () => {
    expect(roomFor(10, 6000)).toBe(60_000);
    expect(roomFor(10, null)).toBe(1);
  });
});

describe('who does what', () => {
  it('pays and submits are never Brick’s, and details and uploads wait for the person to take over', () => {
    expect([...PERSON_ONLY].sort()).toEqual(['pay', 'submit']);
    expect([...AFTER_TAKE_OVER].sort()).toEqual(['details', 'upload']);
  });

  it('a job is over when it is done, stopped or failed', () => {
    expect(['done', 'stopped', 'failed'].every(isOver)).toBe(true);
    expect(['queued', 'running', 'waiting'].some(isOver)).toBe(false);
  });
});

describe('which provider a server runs', () => {
  const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;

  it('has none unless it was told: a server with no key and no pretend setting has no computers at all', () => {
    expect(computerProviderKind(env({}))).toBeNull();
    expect(computerProviderKind(env({ COMPUTER_PROVIDER: '' }))).toBeNull();
    expect(computerProviderKind(env({ COMPUTER_PROVIDER: 'aws' }))).toBeNull();
    // "real" with no key is not a computer provider: there is nothing to call Agent37 with
    expect(computerProviderKind(env({ COMPUTER_PROVIDER: 'real' }))).toBeNull();
  });

  it('the Agent37 key being there turns real computers on, with no other switch', () => {
    expect(computerProviderKind(env({ AGENT37_API_KEY: 'sk_live_x' }))).toBe('real');
    expect(computerProviderKind(env({ AGENT37_API_KEY: ' sk_live_x ', COMPUTER_PROVIDER: '' }))).toBe('real');
    expect(computerProviderKind(env({ AGENT37_API_KEY: '   ' }))).toBeNull();
  });

  it('the pretend setting wins over a key, so a test server never spends', () => {
    expect(computerProviderKind(env({ COMPUTER_PROVIDER: ' Fake ', AGENT37_API_KEY: 'sk_live_x' }))).toBe('fake');
    expect(computerProviderKind(env({ COMPUTER_PROVIDER: 'fake' }))).toBe('fake');
  });

  it('the pretend provider’s screen only exists for a machine that is awake: looking never wakes it', async () => {
    const fake = new FakeComputerProvider();
    expect(await fake.watch('m1')).toBeNull();
    expect(fake.calls.map((call) => call.name)).toEqual(['watch']);
    await fake.wake('m1');
    expect(await fake.watch('m1')).not.toBeNull();
    await fake.rest('m1');
    expect(await fake.watch('m1')).toBeNull();
  });

  it('the pretend provider makes the same machine for the same Brick', async () => {
    const fake = new FakeComputerProvider();
    expect((await fake.create('b1')).ref).toBe((await fake.create('b1')).ref);
  });
});
