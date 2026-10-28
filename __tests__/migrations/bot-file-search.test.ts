/**
 * The search over files in bot chats (game #1508), on a real Postgres (PGlite) built from every migration: who finds
 * what, the filters, words in any language, pages, and one person with 10,000 files.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let result: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(() => {
  const tsx = path.join(__dirname, '../../node_modules/.bin/tsx');
  const output = execFileSync(tsx, [path.join(__dirname, '../helpers/run-bot-file-search.ts')], { encoding: 'utf8', timeout: 150_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string);
}, 180_000);

const rows = (key: string) => result[key].rows;

describe('bot file search on Postgres', () => {
  it('finds the person\'s own files from any chat with this bot, and never another bot\'s', () => {
    expect(rows('ownerInDm')).toEqual(['bubble-pic', 'dm-plan', 'dm-song']);
  });

  it('adds the files of the chat they are in: a friend\'s and a guest\'s, while it lasts', () => {
    expect(rows('ownerInBubble')).toEqual(['guest-pic', 'friend-notes', 'bubble-pic', 'dm-plan', 'dm-song']);
  });

  it('never shows someone else\'s files from another chat: a friend never finds the owner\'s direct messages', () => {
    expect(rows('friendInBubble')).toEqual(['guest-pic', 'friend-notes', 'bubble-pic', 'friend-old']);
    expect(rows('friendLater')).toEqual(['friend-notes', 'friend-old']);
    expect(rows('friendCannotFindOwnerDm')).toEqual([]);
  });

  it('gives a guest only the chat\'s files, and theirs go after a day', () => {
    expect(rows('guestInBubble')).toEqual(['guest-pic', 'friend-notes', 'bubble-pic']);
    expect(rows('guestAfterDay')).toEqual(['friend-notes', 'bubble-pic']);
  });

  it('keeps to the super admin\'s days, a kind, who sent it and dates', () => {
    expect(rows('findableDays')).toEqual(['bubble-pic', 'dm-plan']);
    expect(rows('kinds')).toEqual(['bubble-pic', 'dm-song']);
    expect(rows('source')).toEqual(['dm-song']);
    expect(rows('dates')).toEqual(['bubble-pic', 'dm-plan']);
  });

  it('finds words in a name, a line or the kept text, from the start of a word, in Arabic too', () => {
    expect(rows('wordInName')).toEqual(['dm-plan', 'dm-song']);
    expect(rows('wordStart')).toEqual(['dm-plan', 'dm-song']);
    expect(rows('wordInLine')).toEqual(['bubble-pic']);
    expect(rows('arabic')).toEqual(['dm-plan']);
    // Arabic with or without short vowels: lyrics with them (a part and a line) found by a word without, and the other way
    expect(rows('markedTextUnmarkedQuery')).toEqual(['bubble-pic', 'dm-plan', 'dm-song']);
    expect(rows('unmarkedTextMarkedQuery')).toEqual(['dm-plan']);
    expect(rows('twoWordsInText')).toEqual(['dm-plan']);
    // And in what a made file was asked for
    expect(rows('byPrompt')).toEqual(['dm-song']);
    expect(result.allMissing.total).toBe(0);
    expect(rows('anyWord')).toEqual(['dm-plan']);
  });

  it('pages with the total, and points at the part that has the words', () => {
    expect(result.page2).toEqual({ total: 3, rows: ['dm-plan'] });
    expect(result.hits).toEqual([
      ['dm-plan', 9100],
      ['friend-notes', 0],
    ]);
  });

  it('a search can not reach outside its words', () => {
    expect(result.injection.total).toBe(0);
    expect(result.stillThere).toBe(8);
  });

  it('answers fast for one person with 10,000 files', () => {
    const { newest, rareWord, commonWord, kindAndPage } = result.bulk;
    expect(newest).toMatchObject({ total: 10000, first: 'bulk-10000', count: 10 });
    expect(rareWord).toMatchObject({ total: 1, first: 'bulk-4321' });
    expect(commonWord).toMatchObject({ total: 10000, count: 10 });
    expect(kindAndPage).toMatchObject({ total: 3333, count: 10 });
    // PGlite runs Postgres in WebAssembly, slower than the real one (about 130 ms at most here, under 300 ms on dev); the
    // margin keeps a slow CI machine from failing it
    for (const run of [newest, rareWord, commonWord, kindAndPage]) expect(run.ms).toBeLessThan(1000);
  });
});
