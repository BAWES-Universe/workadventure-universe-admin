import { open, outputKeyFor, seal } from '@/lib/workbench/store';

describe('the files a code job kept', () => {
  const before = process.env.ENCRYPTION_KEY;
  beforeAll(() => {
    // derivedKey needs a key from the environment; whatever name it reads, one of these is set for the test
    process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
  });
  afterAll(() => {
    if (before === undefined) delete process.env.ENCRYPTION_KEY;
  });

  it('are sealed so the bucket’s copy is not the file, and open to the same bytes', () => {
    const bytes = new TextEncoder().encode('name,total\nsara,10\n');
    const sealed = seal(bytes);
    expect(sealed.subarray(0, 4).toString()).toBe('UCJ1');
    expect(sealed.includes(Buffer.from('sara'))).toBe(false);
    expect(Array.from(open(sealed))).toEqual(Array.from(bytes));
    // A new nonce each time: the same file is never the same bytes twice
    expect(seal(bytes).equals(sealed)).toBe(false);
  });

  it('round-trip an empty file', () => {
    expect(open(seal(new Uint8Array())).length).toBe(0);
  });

  it('are refused when changed, cut short, or not ours', () => {
    const sealed = seal(new TextEncoder().encode('hello'));
    const changed = Buffer.from(sealed);
    changed[changed.length - 20] ^= 1;
    expect(() => open(changed)).toThrow();
    const tag = Buffer.from(sealed);
    tag[tag.length - 1] ^= 1;
    expect(() => open(tag)).toThrow();
    expect(() => open(sealed.subarray(0, 10))).toThrow('Not a kept file');
    expect(() => open(Buffer.concat([Buffer.from('XXXX'), sealed.subarray(4)]))).toThrow('Not a kept file');
  });

  it('are kept under a name of their own, apart from the public artifacts', () => {
    expect(outputKeyFor('job1', 'out1')).toBe('code-jobs/job1/out1.ucj');
  });
});
