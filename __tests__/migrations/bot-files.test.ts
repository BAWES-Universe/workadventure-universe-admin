/**
 * Files in bot chats (game #1508) migration: runs the real migrations on a throwaway database, then this one. Three new
 * tables and two word indexes; nothing already saved changes and nothing is brought over.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let result: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-bot-files-migration.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  result = JSON.parse(output.trim().split('\n').pop() as string);
}, 150_000);

describe('bot files migration', () => {
  it('changes nothing already saved', () => {
    expect(result.after).toEqual(result.before);
  });

  it('starts a file with no text kept and no end', () => {
    expect(result.defaults).toEqual([{ text_state: 'none', text_chars: 0, expires_at: null, has_created: true }]);
  });

  it('gives each short id once per bot, and keeps no file without its bot or text without its file', () => {
    expect(result.duplicateNumber).toMatch(/duplicate key|unique/i);
    expect(result.otherBotSameNumber).toBe(2);
    expect(result.orphanFile).toMatch(/foreign key/i);
    expect(result.orphanPart).toMatch(/foreign key/i);
  });

  it('counts short ids up in one statement, one count per bot', () => {
    expect(result.counted).toEqual([1, 2, 1, 3]);
  });

  it('finds words with Postgres\'s own index, a made-up name and Arabic as they are, with no extension added', () => {
    expect(result.words).toEqual({ marksInTextNotQuery: ['f1', 'f2'], name: ['f1'], arabic: ['f1'], twoWords: ['f1'], none: [], byLine: ['f1'] });
    // A word without short vowels finds it in text without them (f1) and with them (f2); the text itself keeps them
    expect(result.marksKeptInText).toBe(true);
    expect(result.indexes.map((index: { indexname: string }) => index.indexname)).toEqual(['bot_file_parts_words_idx', 'bot_files_words_idx']);
    expect(result.indexes[0].indexdef).toMatch(/USING gin \(words\)/);
    expect(result.indexes[1].indexdef).toMatch(/USING gin \(to_tsvector\('simple'::regconfig/);
    // A part's words are worked out by Postgres when it is saved, so a search never reads the text again
    expect(result.wordsOfAPart).toBe("'about':2 'here':4 'nothing':1 'songs':3");
    expect(result.extensions).toEqual(['plpgsql']);
  });

  it('removes a bot\'s files, their text and its count when the bot goes', () => {
    expect(result.afterBotDeleted).toEqual(['f1', 'f2', 'g1']);
    expect(result.counterAfterBotDeleted).toEqual(['bot1']);
  });

  it('removes a person\'s files and their text when the person leaves, and keeps everyone else\'s', () => {
    expect(result.afterOwnerLeft).toEqual({ files: ['f2', 'g1'], parts: ['f2', 'f2'] });
  });
});
