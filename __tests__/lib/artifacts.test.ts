import {
  ArtifactError,
  applyEdits,
  canAskForChange,
  canOpen,
  checkContent,
  checkVersionRoom,
  sizeLabel,
  cleanLine,
  fileTypeOf,
  newFileKey,
  type ArtifactRules,
} from '@/lib/artifacts';

const MAX = 512 * 1024;
const NOW = new Date('2026-10-26T10:00:00Z');
const base: ArtifactRules = { ownerId: 'owner', chatRef: 'chat-1', openScope: 'chat', changeScope: 'owner', expiresAt: null };
const owner = { userId: 'owner', inChat: false };
const inChat = { userId: 'other', inChat: true };
const outside = { userId: 'other', inChat: false };
const guestInChat = { userId: null, inChat: true };

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as ArtifactError).code;
  }
  return undefined;
}

describe('applyEdits', () => {
  it('replaces a piece that appears once', () => {
    expect(applyEdits('<h1>Quests</h1><p>Todo</p>', [{ old: 'Quests', new: 'Quest board' }], MAX)).toBe('<h1>Quest board</h1><p>Todo</p>');
  });

  it('applies the edits in order, each on the result of the one before', () => {
    expect(applyEdits('a b', [{ old: 'a', new: 'x' }, { old: 'x b', new: 'done' }], MAX)).toBe('done');
  });

  it('replaces every place when asked to', () => {
    expect(applyEdits('btn btn btn', [{ old: 'btn', new: 'button', all: true }], MAX)).toBe('button button button');
  });

  it('stops on a piece that is not there, and says which edit', () => {
    expect(codeOf(() => applyEdits('abc', [{ old: 'b', new: 'x' }, { old: 'zzz', new: 'y' }], MAX))).toBe('edit_not_found');
    expect(() => applyEdits('abc', [{ old: 'b', new: 'x' }, { old: 'zzz', new: 'y' }], MAX)).toThrow('Edit 2');
  });

  it('stops on a piece that appears more than once unless all is asked for', () => {
    expect(codeOf(() => applyEdits('aa', [{ old: 'a', new: 'b' }], MAX))).toBe('edit_ambiguous');
  });

  it('does not treat an overlapping repeat as a second place', () => {
    // "aa" appears once in "aaa" when the second search starts after the first match
    expect(applyEdits('aaa', [{ old: 'aa', new: 'b' }], MAX)).toBe('ba');
  });

  it('stops on an edit with nothing to find', () => {
    expect(codeOf(() => applyEdits('abc', [{ old: '', new: 'x' }], MAX))).toBe('edit_empty');
  });

  it('refuses an edit that would grow the file past the limit, before building it', () => {
    const big = 'a'.repeat(MAX - 10);
    // One short piece, very many places, a long replacement: the result would be gigabytes
    expect(codeOf(() => applyEdits(big, [{ old: 'a', new: 'b'.repeat(100_000), all: true }], MAX))).toBe('too_large');
    expect(codeOf(() => applyEdits('abc', [{ old: 'b', new: 'x'.repeat(MAX + 1) }], MAX))).toBe('too_large');
    // An edit that stays within the limit is fine, and so is one that shrinks a file
    expect(applyEdits(big, [{ old: 'aa', new: 'a', all: true }], MAX).length).toBeLessThan(big.length);
  });

  it('puts $ patterns in the new text as they are', () => {
    expect(applyEdits('price', [{ old: 'price', new: '$& $1 $$' }], MAX)).toBe('$& $1 $$');
  });
});

describe('checkContent', () => {
  it('refuses nothing, and blanks', () => {
    expect(codeOf(() => checkContent('   \n', MAX))).toBe('empty_content');
  });

  it('refuses a file over the cap, counting bytes not letters', () => {
    expect(() => checkContent('a'.repeat(MAX), MAX)).not.toThrow();
    expect(codeOf(() => checkContent('a'.repeat(MAX + 1), MAX))).toBe('too_large');
    expect(codeOf(() => checkContent('é'.repeat(MAX / 2 + 1), MAX))).toBe('too_large');
  });
});

describe('checkVersionRoom', () => {
  it('keeps every version at 0, and stops at a number', () => {
    expect(() => checkVersionRoom(100_000, 0)).not.toThrow();
    expect(() => checkVersionRoom(199, 200)).not.toThrow();
    expect(codeOf(() => checkVersionRoom(200, 200))).toBe('too_many_versions');
  });
});

describe('sizeLabel', () => {
  it('says KB below a megabyte and MB from there', () => {
    expect(sizeLabel(512 * 1024)).toBe('512 KB');
    expect(sizeLabel(2 * 1024 * 1024)).toBe('2 MB');
    expect(sizeLabel(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });
});

describe('cleanLine', () => {
  it('makes one short line', () => {
    expect(cleanLine('  Quests \n  board  ', 50)).toBe('Quests board');
    expect(cleanLine('abcdef', 3)).toBe('abc');
  });

  it('keeps no control characters, which the database would turn down', () => {
    expect(cleanLine('Quests\u0000board\u0007', 50)).toBe('Quests board');
    expect(cleanLine('\u0000\u0001', 10)).toBeNull();
  });

  it('never leaves half an emoji, from a cut or from the start', () => {
    expect(cleanLine('ab😀cd', 3)).toBe('ab');
    expect(cleanLine('ab😀cd', 4)).toBe('ab😀');
    expect(cleanLine('a\uD83Db\uDE00c', 10)).toBe('abc');
  });

  it('gives null when nothing is left', () => {
    expect(cleanLine('   ', 10)).toBeNull();
    expect(cleanLine(null, 10)).toBeNull();
    expect(cleanLine(5, 10)).toBeNull();
  });
});

describe('files', () => {
  it('names a version file by its kind, with a part nobody can guess', () => {
    const a = newFileKey('art', 2, 'app');
    const b = newFileKey('art', 2, 'app');
    expect(a).toMatch(/^artifacts\/art\/v2-[0-9a-f]{24}\.html$/);
    expect(a).not.toBe(b);
    expect(newFileKey('art', 1, 'markdown')).toMatch(/\.md$/);
    expect(newFileKey('art', 1, 'svg')).toMatch(/\.svg$/);
  });

  it('serves each kind as what it is', () => {
    expect(fileTypeOf('app').contentType).toContain('text/html');
    expect(fileTypeOf('svg').contentType).toBe('image/svg+xml');
  });
});

describe('who can open it', () => {
  it('the owner always', () => {
    expect(canOpen(base, owner, NOW)).toBe(true);
  });

  it('people in the chat, when it is set to the chat', () => {
    expect(canOpen(base, inChat, NOW)).toBe(true);
    expect(canOpen(base, guestInChat, NOW)).toBe(true);
  });

  it('nobody outside the chat, even with the id', () => {
    expect(canOpen(base, outside, NOW)).toBe(false);
  });

  it('anyone with the link, when it is set to the link', () => {
    expect(canOpen({ ...base, openScope: 'link' }, outside, NOW)).toBe(true);
  });

  it('a copy, which has no chat, opens only for its owner until it is shared', () => {
    const copy = { ...base, chatRef: null };
    expect(canOpen(copy, { userId: 'other', inChat: true }, NOW)).toBe(false);
    expect(canOpen(copy, owner, NOW)).toBe(true);
    expect(canOpen({ ...copy, openScope: 'link' }, outside, NOW)).toBe(true);
  });

  it('nobody once a guest artifact has run out, not even by link', () => {
    const gone = { ...base, ownerId: null, openScope: 'link', expiresAt: new Date('2026-10-26T09:59:59Z') };
    expect(canOpen(gone, guestInChat, NOW)).toBe(false);
    expect(canOpen({ ...gone, expiresAt: new Date('2026-10-27T10:00:00Z') }, guestInChat, NOW)).toBe(true);
  });
});

describe('who can ask for changes', () => {
  it('the owner, in any chat', () => {
    expect(canAskForChange(base, owner, false, NOW)).toBe(true);
  });

  it('nobody else when it is set to the owner only', () => {
    expect(canAskForChange(base, inChat, true, NOW)).toBe(false);
  });

  it('people who can open it, in the chat it was made in, when the owner allowed it', () => {
    const open = { ...base, changeScope: 'openers' };
    expect(canAskForChange(open, inChat, true, NOW)).toBe(true);
    expect(canAskForChange(open, guestInChat, true, NOW)).toBe(true);
  });

  it('not from another chat, even with the link and the right', () => {
    const open = { ...base, changeScope: 'openers', openScope: 'link' };
    expect(canAskForChange(open, outside, false, NOW)).toBe(false);
  });

  it('anyone in the chat for what a guest asked for, since it has no owner', () => {
    const guests = { ...base, ownerId: null, expiresAt: new Date('2026-10-27T10:00:00Z') };
    expect(canAskForChange(guests, guestInChat, true, NOW)).toBe(true);
    expect(canAskForChange(guests, guestInChat, false, NOW)).toBe(false);
  });

  it('nobody once it has run out', () => {
    expect(canAskForChange({ ...base, expiresAt: new Date('2026-10-26T09:00:00Z') }, owner, true, NOW)).toBe(false);
  });
});
