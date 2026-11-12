/**
 * What a bot remembers about a person, one thing at a time (game #2003): the list, the key of a thing, and taking a
 * thing out together with what was built from it. The same key vectors are tested on the bot server's side.
 */
import { isPrivateHeard, memoryItemKey, memoryItemsOf, withoutForgotten, withoutItems } from '@/lib/bot-memory-items';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 6, 10, 0, 0);

function saved() {
  return {
    personalInfo: {
      name: 'Sara',
      birthday: 'June 5',
      preferences: ['lo-fi with soft keys and rain', 'coffee, no sugar'],
      facts: [
        ['current_state', 'tired'],
        ['tired_mentioned_at', String(T0 + 2 * DAY)],
        ['birthday_mentioned_at', String(T0)],
        ['birthday_today', 'true'],
      ],
      lastInfoUpdate: T0 + 3 * DAY,
      heard: {
        name: { place: 'dm', with: [] },
        birthday: { place: 'dm', with: [] },
        'pref:lo-fi with soft keys and rain': { place: 'nearby', with: ['omar'] },
        'pref:coffee, no sugar': { place: 'dm', with: [] },
        'fact:current_state': { place: 'dm', with: [] },
      },
      drawnFrom: { 'pref:coffee, no sugar': T0 + DAY } as Record<string, number>,
    },
    relationship: {
      firstMet: T0,
      importantEvents: [
        { event: 'first_meeting', timestamp: T0, description: 'First conversation with player', heard: { place: 'open', with: [] } },
        { event: 'birthday_mentioned', timestamp: T0, description: 'Player mentioned birthday: June 5' },
      ],
    },
    conversationHistory: [
      { sender: 'person', message: 'I like coffee, no sugar', timestamp: T0 + DAY },
      { sender: 'bot', message: 'Noted: coffee, no sugar.', timestamp: T0 + DAY + 1000 },
      { sender: 'person', message: 'What is the weather', timestamp: T0 + DAY + 2000 },
    ],
  };
}

describe('the key of a thing', () => {
  it('is the same for the same words in any case and spacing, and differs by kind and by value', () => {
    expect(memoryItemKey('pref', null, 'Coffee, no sugar')).toBe(memoryItemKey('pref', null, '  coffee, no sugar '));
    expect(memoryItemKey('pref', null, 'tea')).not.toBe(memoryItemKey('pref', null, 'coffee'));
    expect(memoryItemKey('name', null, 'sara')).not.toBe(memoryItemKey('pref', null, 'sara'));
    expect(memoryItemKey('fact', 'current_state', 'tired')).not.toBe(memoryItemKey('fact', 'mood', 'tired'));
  });

  it('has fixed values (the bot server tests the same ones)', () => {
    expect(memoryItemKey('name', null, 'Sara')).toBe('bb1c30c5e1d0cd2b3ab27793126097dc');
    expect(memoryItemKey('pref', null, 'coffee, no sugar')).toBe('58235559cd2895d1002b2acd76359a19');
    expect(memoryItemKey('fact', 'current_state', 'tired')).toBe('305e45c0f202f984dae645195abeacec');
    expect(memoryItemKey('birthday', null, 'June 5')).toBe('a6907634748425cf18d7793cf028f961');
  });

  it('keeps no words in it', () => {
    expect(memoryItemKey('pref', null, 'secret plan')).not.toContain('secret');
  });
});

describe('the list', () => {
  it('lists name, birthday, likes and facts, never the notes the bot keeps for itself, newest first', () => {
    const items = memoryItemsOf(saved());
    expect(items.map((item) => [item.kind, item.value, item.label])).toEqual([
      ['fact', 'tired', 'current_state'],
      ['pref', 'coffee, no sugar', null],
      ['birthday', 'June 5', null],
      ['name', 'Sara', null],
      ['pref', 'lo-fi with soft keys and rain', null],
    ]);
  });

  it('says when it was said where the bot kept that, and not where it did not', () => {
    const byValue = Object.fromEntries(memoryItemsOf(saved()).map((item) => [item.value, item.at]));
    expect(byValue['coffee, no sugar']).toBe(T0 + DAY);
    expect(byValue.tired).toBe(T0 + 2 * DAY);
    expect(byValue['June 5']).toBe(T0);
    expect(byValue.Sara).toBeNull();
  });

  it('marks what was said privately, and what was never stamped, as private', () => {
    const byValue = Object.fromEntries(memoryItemsOf(saved()).map((item) => [item.value, item.private]));
    expect(byValue['lo-fi with soft keys and rain']).toBe(false);
    expect(byValue['coffee, no sugar']).toBe(true);
    expect(byValue.Sara).toBe(true);
    expect(isPrivateHeard(undefined)).toBe(true);
    expect(isPrivateHeard({ place: 'nearby', with: [] })).toBe(true);
    expect(isPrivateHeard({ place: 'open', with: [] })).toBe(false);
  });

  it('is empty for a memory it cannot read', () => {
    for (const bad of [null, undefined, 'x', 3, [], {}, { personalInfo: 'x' }]) expect(memoryItemsOf(bad)).toEqual([]);
  });

  it('gives each thing a key that Forget names', () => {
    const items = memoryItemsOf(saved());
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    expect(items.find((item) => item.kind === 'name')?.id).toBe(memoryItemKey('name', null, 'Sara'));
  });
});

describe('taking a thing out', () => {
  const keyOf = (value: string) => memoryItemsOf(saved()).find((item) => item.value === value)!.id;

  it('removes the thing, where it was said, and the line of the chat it was drawn from, and nothing else', () => {
    const before = saved();
    const { data, removed } = withoutItems(before, new Set([keyOf('coffee, no sugar')]));
    expect(removed).toBe(1);
    const after = data as ReturnType<typeof saved>;
    expect(after.personalInfo.preferences).toEqual(['lo-fi with soft keys and rain']);
    expect(after.personalInfo.heard).not.toHaveProperty('pref:coffee, no sugar');
    expect(after.personalInfo.drawnFrom).toEqual({});
    // The person's own line it was drawn from, and the bot's line that repeats it, are gone; the rest of the chat stays
    expect(after.conversationHistory.map((line) => line.message)).toEqual(['What is the weather']);
    expect(after.personalInfo.name).toBe('Sara');
    // It never changes what it was given
    expect(before.personalInfo.preferences).toHaveLength(2);
  });

  it('takes the events and facts written for a birthday with it', () => {
    const after = withoutItems(saved(), new Set([keyOf('June 5')])).data as ReturnType<typeof saved>;
    expect(after.personalInfo).not.toHaveProperty('birthday');
    expect(after.relationship.importantEvents.map((event) => event.event)).toEqual(['first_meeting']);
    expect(after.personalInfo.facts.map(([name]) => name)).toEqual(['current_state', 'tired_mentioned_at']);
  });

  it('takes the note of when a state was said with the state', () => {
    const after = withoutItems(saved(), new Set([keyOf('tired')])).data as ReturnType<typeof saved>;
    expect(after.personalInfo.facts.map(([name]) => name)).toEqual(['birthday_mentioned_at', 'birthday_today']);
  });

  it('with no line noted, takes the lines that hold its words, but never for a short word', () => {
    const memory = saved();
    memory.personalInfo.drawnFrom = {};
    memory.personalInfo.name = 'Al';
    const afterPref = withoutItems(memory, new Set([memoryItemKey('pref', null, 'coffee, no sugar')])).data as typeof memory;
    expect(afterPref.conversationHistory.map((line) => line.message)).toEqual(['What is the weather']);
    memory.conversationHistory.push({ sender: 'person', message: 'Al here, hello', timestamp: T0 + 3 * DAY });
    const afterName = withoutItems(memory, new Set([memoryItemKey('name', null, 'Al')])).data as typeof memory;
    expect(afterName.conversationHistory).toHaveLength(memory.conversationHistory.length);
  });

  it('does nothing for a key it does not hold, or an empty set', () => {
    const memory = saved();
    expect(withoutItems(memory, new Set(['0'.repeat(32)])).removed).toBe(0);
    expect(withoutItems(memory, new Set()).data).toBe(memory);
  });
});

describe('what was forgotten stays gone', () => {
  const coffee = memoryItemKey('pref', null, 'coffee, no sugar');

  it('comes out of a copy the bot server still held', () => {
    const stale = saved();
    const after = withoutForgotten(stale, [{ itemKey: coffee, createdAt: new Date(T0 + 5 * DAY) }]) as typeof stale;
    expect(after.personalInfo.preferences).not.toContain('coffee, no sugar');
  });

  it('comes out of an old row that is restored, with its history', () => {
    const restored = saved();
    const after = withoutForgotten(restored, [{ itemKey: coffee, createdAt: new Date(T0 + 5 * DAY) }]) as typeof restored;
    expect(memoryItemsOf(after).map((item) => item.value)).not.toContain('coffee, no sugar');
    expect(after.conversationHistory.some((line) => line.message.includes('coffee'))).toBe(false);
  });

  it('is learned again when the person says it again afterwards, and not when it only comes from before', () => {
    const forgotAt = new Date(T0 + 5 * DAY);
    const again = saved();
    again.personalInfo.drawnFrom = { 'pref:coffee, no sugar': forgotAt.getTime() + 1000 };
    expect(memoryItemsOf(withoutForgotten(again, [{ itemKey: coffee, createdAt: forgotAt }])).map((item) => item.value)).toContain('coffee, no sugar');
    const before = saved();
    before.personalInfo.drawnFrom = { 'pref:coffee, no sugar': forgotAt.getTime() - 1000 };
    expect(memoryItemsOf(withoutForgotten(before, [{ itemKey: coffee, createdAt: forgotAt }])).map((item) => item.value)).not.toContain('coffee, no sugar');
  });

  it('a thing forgotten twice keeps the later Forget', () => {
    const memory = saved();
    memory.personalInfo.drawnFrom = { 'pref:coffee, no sugar': T0 + 6 * DAY };
    const forgets = [
      { itemKey: coffee, createdAt: new Date(T0 + 5 * DAY) },
      { itemKey: coffee, createdAt: new Date(T0 + 7 * DAY) },
    ];
    expect(memoryItemsOf(withoutForgotten(memory, forgets)).map((item) => item.value)).not.toContain('coffee, no sugar');
  });

  it('changes nothing when nothing was forgotten', () => {
    const memory = saved();
    expect(withoutForgotten(memory, [])).toBe(memory);
  });
});
