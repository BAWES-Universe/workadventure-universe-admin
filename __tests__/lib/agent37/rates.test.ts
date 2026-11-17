import { awakeMicrosPerMinute, dayOfRunningMicros, keptDiskMonthMicros, BRICK_SHAPE } from '@/lib/agent37/rates';

describe('what Agent37 charges for a Brick’s computer', () => {
  it('matches the check on a real machine: about $0.0065 an hour for 2 CPU, 4 GB, 4 GB disk', () => {
    const hour = (awakeMicrosPerMinute(BRICK_SHAPE) * 60) / 1_000_000;
    expect(hour).toBeCloseTo(0.00652, 5);
  });

  it('keeps a 4 GB disk for $0.36 a month', () => {
    expect(keptDiskMonthMicros(BRICK_SHAPE)).toBe(360_000);
  });

  it('prices the other machine types by their multiple of the compute rate, disk at the same price', () => {
    const normal = awakeMicrosPerMinute({ cpu: 2, memory: 4, disk: 4 });
    const vm = awakeMicrosPerMinute({ cpu: 2, memory: 4, disk: 4, type: 'vm' });
    const disk = (4 * 90_000) / (730 * 60);
    expect((vm - disk) / (normal - disk)).toBeCloseTo(2.5, 5);
  });

  it('a day of running is what Agent37 asks the wallet to hold for a new machine', () => {
    expect(dayOfRunningMicros(BRICK_SHAPE)).toBeGreaterThan(150_000);
    expect(dayOfRunningMicros(BRICK_SHAPE)).toBeLessThan(160_000);
  });
});
