import { isBotIdentifier } from '@/lib/bot-visitor';

describe('isBotIdentifier', () => {
  it('recognises a bot joining a room', () => {
    expect(isBotIdentifier('bot-d5f35a6d-b2ae-4f4a-a321-537fe5e7a094')).toBe(true);
    expect(isBotIdentifier('bot-F145F11F-FC94-4B73-830B-00F2736245C2')).toBe(true);
  });

  it('keeps people as people', () => {
    expect(isBotIdentifier('d5f35a6d-b2ae-4f4a-a321-537fe5e7a094')).toBe(false); // a guest
    expect(isBotIdentifier('bot-fan@example.com')).toBe(false); // an email that starts with "bot-"
    expect(isBotIdentifier('bot-')).toBe(false);
    expect(isBotIdentifier('robot-d5f35a6d-b2ae-4f4a-a321-537fe5e7a094')).toBe(false);
    expect(isBotIdentifier(null)).toBe(false);
    expect(isBotIdentifier(undefined)).toBe(false);
  });
});
