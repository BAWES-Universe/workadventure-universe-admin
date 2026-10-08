import { nameColour } from '@/lib/name-colour';

describe('nameColour', () => {
  // Values from the game's own getColorByString (play/src/front/Utils/ColorGenerator.ts), so a face matches there.
  it.each([
    ['Omar', '#997b4d'],
    ['Sara', '#99794d'],
    ['Noor', '#81994d'],
    ['Nova', '#694d99'],
    ['Zed', '#4d9994'],
    ['Yousef', '#794d99'],
    ['AH(Melon)', '#994d58'],
    ['1e6ed2ee-cc2b-410b-8828-8598f1df288f', '#4d994f'],
  ])('gives %s the game colour %s', (name, colour) => {
    expect(nameColour(name)).toBe(colour);
  });

  it('gives the same name the same colour, and nothing for no name', () => {
    expect(nameColour('Omar')).toBe(nameColour('Omar'));
    expect(nameColour('')).toBeNull();
    expect(nameColour(null)).toBeNull();
    expect(nameColour(undefined)).toBeNull();
  });
});
