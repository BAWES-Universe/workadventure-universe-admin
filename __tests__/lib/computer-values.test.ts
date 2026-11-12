/** A Brick's computer (game #2000): the rules that need no database, and which provider a server runs. */
import { computerProviderKind, FakeComputerProvider, RealComputerProvider, ComputerProviderOff } from '@/lib/computer-provider';
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
  it('has none unless it was told: a server that was not told has no computers at all', () => {
    expect(computerProviderKind({} as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(computerProviderKind({ COMPUTER_PROVIDER: '' } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(computerProviderKind({ COMPUTER_PROVIDER: 'aws' } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(computerProviderKind({ COMPUTER_PROVIDER: ' Fake ' } as unknown as NodeJS.ProcessEnv)).toBe('fake');
    expect(computerProviderKind({ COMPUTER_PROVIDER: 'real' } as unknown as NodeJS.ProcessEnv)).toBe('real');
  });

  it('the real provider is wired and off: every call says so and no price is claimed', async () => {
    const real = new RealComputerProvider();
    expect(real.microsPerMinute()).toBeNull();
    await expect(real.create()).rejects.toBeInstanceOf(ComputerProviderOff);
    await expect(real.wake()).rejects.toBeInstanceOf(ComputerProviderOff);
    await expect(real.watch()).rejects.toBeInstanceOf(ComputerProviderOff);
    await expect(real.saveFiles()).rejects.toBeInstanceOf(ComputerProviderOff);
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
