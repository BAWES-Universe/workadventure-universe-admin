/**
 * The owner's Welcome chapter: what the form may publish, the record kept in this browser (read back as untrusted
 * input), and the link that carries the owner's choices into the game.
 */
import {
  EMPTY_QUEST_DRAFT,
  draftFromPublished,
  draftProblems,
  parsePublishedQuest,
  publishedFromDraft,
  questVisitUrl,
  upgradeQuestDraft,
  type QuestContext,
} from '@/lib/quests/model';

const CONTEXT: QuestContext = {
  areas: [
    { id: 'a-1', name: 'Courtyard' },
    { id: 'a-2', name: 'Café & Bar' },
  ],
  bots: [{ id: '0b5f1c2e-1111-4a4a-8b8b-123456789abc', name: 'Nova' }],
  source: 'wam',
};

describe('upgradeQuestDraft', () => {
  it('keeps only fields of the right type', () => {
    expect(upgradeQuestDraft({ meet: false, areaId: 'a-1', hostKind: 'bot', hostId: 'b', build: 'yes', extra: 1 })).toEqual({
      ...EMPTY_QUEST_DRAFT,
      meet: false,
      areaId: 'a-1',
      hostKind: 'bot',
      hostId: 'b',
    });
    expect(upgradeQuestDraft({ hostKind: 'person', areaId: 'x'.repeat(500) })).toEqual(EMPTY_QUEST_DRAFT);
    expect(upgradeQuestDraft('nope')).toBeNull();
    expect(upgradeQuestDraft([])).toBeNull();
  });
});

describe('draftProblems', () => {
  it('asks for an area beside Explore, a host beside the host choice, and something to do', () => {
    expect(draftProblems({ ...EMPTY_QUEST_DRAFT, areaId: '' }, CONTEXT)).toEqual({ area: 'Pick an area or skip this path.' });
    expect(draftProblems({ ...EMPTY_QUEST_DRAFT, explore: false, hostKind: 'bot', hostId: '' }, CONTEXT)).toEqual({
      host: 'Pick a bot, or choose No host.',
    });
    expect(draftProblems({ ...EMPTY_QUEST_DRAFT, meet: false, explore: false }, CONTEXT)).toEqual({ paths: 'Choose at least one thing to do.' });
    expect(draftProblems({ ...EMPTY_QUEST_DRAFT, areaId: 'a-1' }, CONTEXT)).toEqual({});
  });

  it('refuses an area that is no longer on the map', () => {
    expect(draftProblems({ ...EMPTY_QUEST_DRAFT, areaId: 'gone' }, CONTEXT).area).toBeDefined();
  });
});

describe('the published record', () => {
  const quest = publishedFromDraft({ ...EMPTY_QUEST_DRAFT, areaId: 'a-2', hostKind: 'bot', hostId: CONTEXT.bots[0].id }, CONTEXT, 'live', new Date('2026-09-28T10:00:00Z'));

  it('carries the names the owner picked', () => {
    expect(quest).toEqual({
      v: 1,
      status: 'live',
      paths: { meet: true, explore: true, build: false },
      area: { id: 'a-2', name: 'Café & Bar' },
      host: { kind: 'bot', id: CONTEXT.bots[0].id, name: 'Nova' },
      publishedAt: '2026-09-28T10:00:00.000Z',
    });
    expect(draftFromPublished(quest)).toEqual({ ...EMPTY_QUEST_DRAFT, areaId: 'a-2', hostKind: 'bot', hostId: CONTEXT.bots[0].id });
  });

  it('reads back what it wrote', () => {
    expect(parsePublishedQuest(JSON.stringify(quest))).toEqual(quest);
  });

  it.each([
    ['nothing', null],
    ['not JSON', '{nope'],
    ['another version', JSON.stringify({ ...quest, v: 2 })],
    ['an unknown status', JSON.stringify({ ...quest, status: 'deleted' })],
    ['a path that is not on or off', JSON.stringify({ ...quest, paths: { meet: 'yes', explore: true, build: false } })],
    ['a host of another kind', JSON.stringify({ ...quest, host: { kind: 'person', id: 'x', name: 'x' } })],
    ['an over-long name', JSON.stringify({ ...quest, area: { id: 'a', name: 'x'.repeat(200) } })],
    ['a bad date', JSON.stringify({ ...quest, publishedAt: 'yesterday' })],
    ['something huge', JSON.stringify({ ...quest, junk: 'x'.repeat(5000) })],
  ])('ignores %s', (_, raw) => {
    expect(parsePublishedQuest(raw)).toBeNull();
  });

  it('never offers Explore without an area', () => {
    expect(parsePublishedQuest(JSON.stringify({ ...quest, area: null }))?.paths.explore).toBe(false);
  });
});

describe('questVisitUrl', () => {
  const live = publishedFromDraft({ ...EMPTY_QUEST_DRAFT, areaId: 'a-2', hostKind: 'bot', hostId: CONTEXT.bots[0].id }, CONTEXT, 'live');

  it('adds the area and host in the shape the game reads (key=value pairs, each value encoded)', () => {
    const url = questVisitUrl('/@/bawes/office/lobby', live);
    expect(url).toBe(
      `/@/bawes/office/lobby#questArea=Caf%C3%A9%20%26%20Bar&questHost=${encodeURIComponent(`bot:bot-${CONTEXT.bots[0].id}`)}`,
    );
    // As the game's QuestHash.ts splits and decodes it.
    const pairs = Object.fromEntries(url.split('#')[1].split('&').map((pair) => pair.split('=').map(decodeURIComponent)));
    expect(pairs).toEqual({ questArea: 'Café & Bar', questHost: `bot:bot-${CONTEXT.bots[0].id}` });
  });

  it('names an area host and no host', () => {
    const area = publishedFromDraft({ ...EMPTY_QUEST_DRAFT, explore: false, hostKind: 'area', hostId: 'a-1' }, CONTEXT, 'live');
    expect(questVisitUrl('/@/u/w/r', area)).toBe('/@/u/w/r#questHost=area%3ACourtyard');
    const none = publishedFromDraft({ ...EMPTY_QUEST_DRAFT, explore: false }, CONTEXT, 'live');
    expect(questVisitUrl('/@/u/w/r', none)).toBe('/@/u/w/r#questHost=none');
  });

  it('visits the plain room while paused or with nothing published', () => {
    expect(questVisitUrl('/@/u/w/r', { ...live, status: 'paused' })).toBe('/@/u/w/r');
    expect(questVisitUrl('/@/u/w/r', null)).toBe('/@/u/w/r');
  });
});
