import { stampNameLength } from '@/lib/stamps';

describe('stampNameLength', () => {
  it('leaves names whose words fit a small stamp as they are', () => {
    expect(stampNameLength('HQ')).toBeUndefined();
    expect(stampNameLength('BAWES World')).toBeUndefined();
    expect(stampNameLength('Sandbox World')).toBeUndefined();
  });

  it('marks a long word, and a longer one, by the longest word only', () => {
    expect(stampNameLength('Shopfront')).toBe('long');
    expect(stampNameLength('My Playground')).toBe('long');
    expect(stampNameLength('Experimental')).toBe('longer');
    expect(stampNameLength('')).toBeUndefined();
  });
});
