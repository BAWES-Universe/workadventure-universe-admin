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

  it('takes the lines that hold an ordinary fact too, when no line was noted for it', () => {
    const memory = saved();
    memory.personalInfo.facts.push(['employer', 'Acme Corp'], ['age', '31']);
    memory.conversationHistory.push({ sender: 'person', message: 'I work at Acme Corp', timestamp: T0 + 3 * DAY }, { sender: 'person', message: 'I am 31', timestamp: T0 + 3 * DAY + 1 });
    const after = withoutItems(memory, new Set([memoryItemKey('fact', 'employer', 'Acme Corp')])).data as typeof memory;
    expect(after.personalInfo.facts.map(([name]) => name)).not.toContain('employer');
    expect(after.conversationHistory.map((line) => line.message)).not.toContain('I work at Acme Corp');
    expect(after.conversationHistory.map((line) => line.message)).toContain('I am 31');
    // A short value is never searched for in the chat
    const shortOne = withoutItems(memory, new Set([memoryItemKey('fact', 'age', '31')])).data as typeof memory;
    expect(shortOne.conversationHistory.map((line) => line.message)).toContain('I am 31');
  });

  it('looks for the words of a fact as whole words in the chat: "Rome" takes "I live in Rome" and leaves "Chrome keeps crashing"', () => {
    const memory = saved();
    memory.personalInfo.facts.push(['home_city', 'Rome']);
    memory.conversationHistory.push({ sender: 'person', message: 'I live in Rome', timestamp: T0 + 3 * DAY }, { sender: 'person', message: 'Chrome keeps crashing', timestamp: T0 + 3 * DAY + 1 }, { sender: 'person', message: 'Rome, again', timestamp: T0 + 3 * DAY + 2 });
    const after = withoutItems(memory, new Set([memoryItemKey('fact', 'home_city', 'Rome')])).data as typeof memory;
    const lines = after.conversationHistory.map((line) => line.message);
    expect(lines).not.toContain('I live in Rome');
    expect(lines).not.toContain('Rome, again');
    expect(lines).toContain('Chrome keeps crashing');
    // Words that end in a symbol or hold spaces still match as before
    memory.personalInfo.facts.push(['employer', 'Acme Corp.']);
    memory.conversationHistory.push({ sender: 'person', message: 'I work at Acme Corp. now', timestamp: T0 + 4 * DAY });
    const employer = withoutItems(memory, new Set([memoryItemKey('fact', 'employer', 'Acme Corp.')])).data as typeof memory;
    expect(employer.conversationHistory.map((line) => line.message)).not.toContain('I work at Acme Corp. now');
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

  it('takes out the lines that say it from before the Forget, and keeps the ones said after it', () => {
    const forgotAt = new Date(T0 + 5 * DAY);
    const memory = saved();
    // What was kept before this carries no moment for it, so the person's own lines holding its words go too, but only the ones from before
    memory.personalInfo.drawnFrom = {};
    memory.conversationHistory.push(
      { sender: 'person', message: 'I still like coffee, no sugar', timestamp: forgotAt.getTime() + 1000 },
      { sender: 'bot', message: 'Coffee, no sugar, got it', timestamp: forgotAt.getTime() + 2000 },
    );
    const after = withoutForgotten(memory, [{ itemKey: coffee, createdAt: forgotAt }]) as typeof memory;
    expect(after.conversationHistory.map((line) => line.message)).toEqual(['What is the weather', 'I still like coffee, no sugar', 'Coffee, no sugar, got it']);
    // Without a Forget time (taking it out by hand) every line goes
    const all = withoutItems(memory, new Set([coffee])).data as typeof memory;
    expect(all.conversationHistory.map((line) => line.message)).toEqual(['What is the weather']);
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

describe('taking out what was said plainly (favorites and short words)', () => {
  const memoryWith = (preference: string, lines: Array<[string, string, number]>) => ({
    personalInfo: { preferences: [preference], facts: [], heard: {}, drawnFrom: { [`pref:${preference}`]: lines.at(-1)![2] } },
    conversationHistory: lines.map(([sender, message, timestamp]) => ({ sender, message, timestamp })),
  });
  const forget = (data: ReturnType<typeof memoryWith>, preference: string) => {
    const after = withoutItems(data, new Set([memoryItemKey('pref', null, preference)])).data as ReturnType<typeof memoryWith>;
    return after.conversationHistory.map((line) => line.message);
  };

  it('forgetting a favorite looks for it as it is said ("pizza"), long or short', () => {
    expect(
      forget(
        memoryWith('pizza (favorite food)', [
          ['person', 'my favorite food is pizza', 1000],
          ['bot', 'Pizza is your favorite food, got it!', 1500],
          ['person', 'I walk a lot', 2000],
          ['person', 'again, my favorite food is pizza', 3000],
        ]),
        'pizza (favorite food)',
      ),
    ).toEqual(['I walk a lot']);
    expect(
      forget(
        memoryWith('tea (favorite drink)', [
          ['person', 'my favorite drink is tea', 1000],
          ['bot', 'Tea is your favorite drink!', 1500],
          ['person', 'I walk a lot', 2000],
          ['person', 'again, my favorite drink is tea', 3000],
        ]),
        'tea (favorite drink)',
      ),
    ).toEqual(['I walk a lot']);
  });

  it('forgetting a short like said twice takes the first line and what the bot says back, and keeps what only has the letters', () => {
    expect(
      forget(
        memoryWith('tea', [
          ['person', 'I like tea', 1000],
          ['bot', 'Tea, you like it!', 1500],
          ['person', 'I like steam rooms', 2000],
          ['bot', 'Steam rooms are great', 2500],
          ['person', 'I like tea a lot', 3000],
        ]),
        'tea',
      ),
    ).toEqual(['I like steam rooms', 'Steam rooms are great']);
  });

  it('forgetting a short dislike takes the lines that say it, as a like does', () => {
    const data = {
      personalInfo: { preferences: [], facts: [['dislike_tea_x', 'tea']], heard: {}, drawnFrom: { 'fact:dislike_tea_x': 3000 } },
      conversationHistory: [
        { sender: 'person', message: 'I hate tea', timestamp: 1000 },
        { sender: 'bot', message: 'You hate tea, noted.', timestamp: 1500 },
        { sender: 'person', message: 'I like steam rooms', timestamp: 2000 },
        { sender: 'person', message: 'honestly I hate tea', timestamp: 3000 },
      ],
    };
    const after = withoutItems(data, new Set([memoryItemKey('fact', 'dislike_tea_x', 'tea')])).data as typeof data;
    expect(after.conversationHistory.map((line) => line.message)).toEqual(['I like steam rooms']);
  });
});

describe('taking out every line that says a thing, said once or twice', () => {
  const chat = (lines: Array<[string, string, number]>) => lines.map(([sender, message, timestamp]) => ({ sender, message, timestamp }));
  const after = (data: unknown, key: string) => (withoutItems(data, new Set([key])).data as { conversationHistory: Array<{ message: string }> }).conversationHistory.map((line) => line.message);

  it('takes the first line of a long value said twice, for a name, a favorite and a dislike', () => {
    const name = {
      personalInfo: { name: 'Sara', facts: [], heard: {}, drawnFrom: { name: 3000 } },
      conversationHistory: chat([['person', 'my name is Sara', 1000], ['bot', 'Hi Sara!', 1500], ['person', 'I walk a lot', 2000], ['person', 'call me Sara', 3000]]),
    };
    expect(after(name, memoryItemKey('name', null, 'Sara'))).toEqual(['I walk a lot']);
    const dislike = {
      personalInfo: { preferences: [], facts: [['dislike_coffee_x', 'coffee']], heard: {}, drawnFrom: { 'fact:dislike_coffee_x': 3000 } },
      conversationHistory: chat([['person', 'I hate coffee', 1000], ['person', 'I walk a lot', 2000], ['person', 'honestly I hate coffee', 3000]]),
    };
    expect(after(dislike, memoryItemKey('fact', 'dislike_coffee_x', 'coffee'))).toEqual(['I walk a lot']);
  });

  it('finds a name written with a capital only as written, so "I will travel" stays when "Will" is forgotten', () => {
    const data = {
      personalInfo: { name: 'Will', facts: [], heard: {}, drawnFrom: { name: 3000 } },
      conversationHistory: chat([['person', 'my name is Will', 1000], ['person', 'I will travel soon', 2000], ['bot', 'I will remember that', 2500], ['person', 'call me Will', 3000]]),
    };
    expect(after(data, memoryItemKey('name', null, 'Will'))).toEqual(['I will travel soon', 'I will remember that']);
  });

  it('forgetting a short name takes the lines that give it and say it back, and keeps a longer name that starts like it', () => {
    const data = {
      personalInfo: { name: 'Ali', facts: [], heard: {}, drawnFrom: { name: 3000 } },
      conversationHistory: chat([
        ['person', 'my name is Ali', 1000],
        ['bot', 'Nice to meet you, Ali!', 1500],
        ['person', 'I like Alice in Wonderland', 2000],
        ['bot', 'Ali, how was your day?', 2500],
        ['person', "I'm Ali, as I said", 3000],
      ]),
    };
    expect(after(data, memoryItemKey('name', null, 'Ali'))).toEqual(['I like Alice in Wonderland']);
  });

  it("forgetting another short value takes the bot's reply right after its line", () => {
    const data = {
      personalInfo: { facts: [['current_state', 'ill'], ['ill_mentioned_at', '1000']], heard: {}, drawnFrom: { 'fact:current_state': 1000 } },
      conversationHistory: chat([['person', "I'm ill", 1000], ['bot', 'Sorry you are ill, rest well', 1500], ['person', 'what is the weather', 2000], ['bot', 'Sunny', 2500]]),
    };
    expect(after(data, memoryItemKey('fact', 'current_state', 'ill'))).toEqual(['what is the weather', 'Sunny']);
  });

  it("forgetting a short like said twice takes the bot's reply after the first line, and finds \"I avoid tea\" and \"sick of tea\"", () => {
    const like = {
      personalInfo: { preferences: ['tea'], facts: [], heard: {}, drawnFrom: { 'pref:tea': 3000 } },
      conversationHistory: chat([['person', 'I like tea', 1000], ['bot', 'Tea it is!', 1500], ['person', 'I like steam rooms', 2000], ['bot', 'Steam rooms are great', 2500], ['person', 'I like tea a lot', 3000]]),
    };
    expect(after(like, memoryItemKey('pref', null, 'tea'))).toEqual(['I like steam rooms', 'Steam rooms are great']);
    const dislike = {
      personalInfo: { preferences: [], facts: [['dislike_tea_x', 'tea']], heard: {}, drawnFrom: { 'fact:dislike_tea_x': 3000 } },
      conversationHistory: chat([['person', 'I avoid tea', 1000], ['person', "I'm sick of tea", 2000], ['bot', 'Noted, no tea', 2200], ['person', 'I hate tea', 3000]]),
    };
    expect(after(dislike, memoryItemKey('fact', 'dislike_tea_x', 'tea'))).toEqual([]);
  });
});

describe('names in other capitals, and a stale copy, and several things forgotten at once', () => {
  const chat = (lines: Array<[string, string, number]>) => lines.map(([sender, message, timestamp]) => ({ sender, message, timestamp }));

  it('takes the lines that give a name in other capitals, long or short, and keeps "I will travel" when "Will" is forgotten', () => {
    const sara = {
      personalInfo: { name: 'Sara', facts: [], heard: {}, drawnFrom: { name: 3000 } },
      conversationHistory: chat([['person', 'my name is sara', 1000], ['person', 'I walk a lot', 2000], ['person', 'My name is Sara', 3000]]),
    };
    const afterSara = withoutItems(sara, new Set([memoryItemKey('name', null, 'Sara')])).data as typeof sara;
    expect(afterSara.conversationHistory.map((line) => line.message)).toEqual(['I walk a lot']);
    const will = {
      personalInfo: { name: 'Will', facts: [], heard: {}, drawnFrom: { name: 3000 } },
      conversationHistory: chat([['person', 'call me will', 1000], ['person', 'I will travel soon', 2000], ['person', 'My name is Will', 3000]]),
    };
    const afterWill = withoutItems(will, new Set([memoryItemKey('name', null, 'Will')])).data as typeof will;
    expect(afterWill.conversationHistory.map((line) => line.message)).toEqual(['I will travel soon']);
  });

  it('takes a bot line that says a forgotten name whenever it was said, and keeps the person saying it again after the Forget', () => {
    const copy = (drawnAt: number, lines: Array<[string, string, number]>) => ({
      personalInfo: { name: 'Ali', facts: [], heard: {}, drawnFrom: { name: drawnAt } },
      conversationHistory: chat(lines),
    });
    const key = memoryItemKey('name', null, 'Ali');
    const forgot = new Map([[key, new Date(3000)]]);
    const stale = withoutForgotten([copy(1000, [['person', 'my name is Ali', 1000], ['bot', 'Hi Ali', 3500]])][0], [{ itemKey: key, createdAt: new Date(3000) }]) as ReturnType<typeof copy>;
    expect(stale.personalInfo.name).toBeUndefined();
    expect(stale.conversationHistory).toEqual([]);
    const again = withoutItems(copy(5000, [['person', 'my name is Ali', 1000], ['bot', 'Hi Ali', 3500], ['person', 'my name is Ali', 5000]]), new Set([key]), forgot).data as ReturnType<typeof copy>;
    expect(again.personalInfo.name).toBe('Ali');
    expect(again.conversationHistory).toHaveLength(3);
  });

  it("takes the bot's reply after a taken line only for the words of the thing that took it, when several are forgotten at once", () => {
    const data = {
      personalInfo: { preferences: ['tea', 'jam'], facts: [], heard: {}, drawnFrom: { 'pref:tea': 1000, 'pref:jam': 3000 } },
      conversationHistory: chat([['person', 'I like tea', 1000], ['bot', 'Jam is nice too', 1500], ['person', 'I like jam', 3000]]),
    };
    const after = withoutItems(data, new Set([memoryItemKey('pref', null, 'tea'), memoryItemKey('pref', null, 'jam')])).data as typeof data;
    expect(after.conversationHistory.map((line) => line.message)).toEqual(['Jam is nice too']);
  });
});

describe('the thing said first, and a reply after a line said again (CodeRabbit)', () => {
  const chat = (lines: Array<[string, string, number]>) => lines.map(([sender, message, timestamp]) => ({ sender, message, timestamp }));

  it('takes "Tea is my favorite drink" and "Tea, I love it" when "tea" is forgotten, and keeps "steam" lines', () => {
    const data = {
      personalInfo: { preferences: ['tea (favorite drink)'], facts: [], heard: {}, drawnFrom: { 'pref:tea (favorite drink)': 1000 } },
      conversationHistory: chat([['person', 'Tea is my favorite drink', 1000], ['person', 'Steam is my favorite room', 1500], ['person', 'Tea, I love it', 2000]]),
    };
    const after = withoutItems(data, new Set([memoryItemKey('pref', null, 'tea (favorite drink)')])).data as typeof data;
    expect(after.conversationHistory.map((line) => line.message)).toEqual(['Steam is my favorite room']);
  });

  it("still takes a bot line that says another forgotten thing, when it comes right after a line said again for one of them", () => {
    const tea = memoryItemKey('pref', null, 'tea');
    const pizza = memoryItemKey('pref', null, 'pizza');
    const data = {
      personalInfo: { preferences: ['tea', 'pizza'], facts: [], heard: {}, drawnFrom: { 'pref:tea': 1000, 'pref:pizza': 1000 } },
      conversationHistory: chat([['person', 'I like tea and pizza', 1000], ['person', 'I like tea', 5000], ['bot', 'Tea it is! And pizza?', 5500], ['person', 'what is the weather', 6000]]),
    };
    const forgot = new Map([[tea, new Date(3000)], [pizza, new Date(3000)]]);
    const after = withoutItems(data, new Set([tea, pizza]), forgot).data as typeof data;
    expect(after.conversationHistory.map((line) => line.message)).toEqual(['I like tea', 'what is the weather']);
  });
});

describe('forgetting leans to taking too much (deliberate)', () => {
  it('a capitalised name that is also a word also takes a line that only starts with it, in that person\'s own chat', () => {
    const data = {
      personalInfo: { name: 'Will', facts: [], heard: {}, drawnFrom: { name: 1000 } },
      conversationHistory: [
        { sender: 'person', message: 'my name is Will', timestamp: 1000 },
        { sender: 'person', message: 'Will you help me?', timestamp: 2000 },
        { sender: 'person', message: 'I will travel soon', timestamp: 3000 },
      ],
    };
    const after = withoutItems(data, new Set([memoryItemKey('name', null, 'Will')])).data as typeof data;
    // "I will travel soon" stays (the word in lower case); "Will you help me?" goes with the name, on purpose
    expect(after.conversationHistory.map((line) => line.message)).toEqual(['I will travel soon']);
  });
});

describe('a reply after a taken line, when several things are forgotten together', () => {
  const chat = (lines: Array<[string, string, number]>) => lines.map(([sender, message, timestamp]) => ({ sender, message, timestamp }));

  it("also takes a reply that says the short value of another forgotten thing already said earlier (a like, and an age)", () => {
    const jam = {
      personalInfo: { preferences: ['jam', 'tea'], facts: [], heard: {}, drawnFrom: { 'pref:jam': 1000, 'pref:tea': 2000 } },
      conversationHistory: chat([['person', 'I like jam', 1000], ['person', 'I like tea', 2000], ['bot', 'Have it with jam!', 2500], ['person', 'I like walking', 3000]]),
    };
    const afterJam = withoutItems(jam, new Set([memoryItemKey('pref', null, 'jam'), memoryItemKey('pref', null, 'tea')])).data as typeof jam;
    expect(afterJam.conversationHistory.map((line) => line.message)).toEqual(['I like walking']);
    const age = {
      personalInfo: { preferences: ['tea'], facts: [['age', '30']], heard: {}, drawnFrom: { 'fact:age': 1000, 'pref:tea': 2000 } },
      conversationHistory: chat([['person', "I'm 30", 1000], ['person', 'I like tea', 2000], ['bot', 'Great choice at 30!', 2500], ['person', 'I like walking', 3000]]),
    };
    const afterAge = withoutItems(age, new Set([memoryItemKey('pref', null, 'tea'), memoryItemKey('fact', 'age', '30')])).data as typeof age;
    expect(afterAge.conversationHistory.map((line) => line.message)).toEqual(['I like walking']);
  });

  it('keeps a reply that says a thing which is only said later', () => {
    const data = {
      personalInfo: { preferences: ['tea', 'jam'], facts: [], heard: {}, drawnFrom: { 'pref:tea': 1000, 'pref:jam': 3000 } },
      conversationHistory: chat([['person', 'I like tea', 1000], ['bot', 'Jam is nice too', 1500], ['person', 'I like jam', 3000]]),
    };
    const after = withoutItems(data, new Set([memoryItemKey('pref', null, 'tea'), memoryItemKey('pref', null, 'jam')])).data as typeof data;
    expect(after.conversationHistory.map((line) => line.message)).toEqual(['Jam is nice too']);
  });
});
