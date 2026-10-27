import { NextRequest } from 'next/server';
import { POST as make } from '@/app/api/artifacts/route';
import { POST as change } from '@/app/api/artifacts/[id]/change/route';
import { POST as read } from '@/app/api/artifacts/[id]/read/route';
import { POST as restore } from '@/app/api/artifacts/[id]/restore/route';
import { POST as copy } from '@/app/api/artifacts/[id]/copy/route';
import { POST as open } from '@/app/api/artifacts/[id]/open/route';
import { DELETE as remove } from '@/app/api/artifacts/[id]/route';
import { checkBotAccess } from '@/lib/bot-access';
import { loadBotPrivacy } from '@/lib/bot-privacy';
import { pruneExpired, resetPruneClock } from '@/lib/artifact-service';
import { checkMediaFile, mediaKeyFor, mergeMedia, newFileKey } from '@/lib/artifacts';
import { addBot, addUser, db, fakeFiles } from '../../helpers/artifacts-db';

jest.mock('@/lib/db', () => ({ prisma: jest.requireActual('../../helpers/artifacts-db').fakePrisma }));
jest.mock('@/lib/artifact-storage', () => ({ artifactFiles: jest.requireActual('../../helpers/artifacts-db').fakeFiles }));
jest.mock('@/lib/bot-access', () => ({ checkBotAccess: jest.fn() }));
jest.mock('@/lib/bot-privacy', () => ({ loadBotPrivacy: jest.fn() }));

/** Songs, images and videos inside artifacts (game #1510): stored beside each version, kept, copied and cleared with it. */

const BOT_TOKEN = 'test-bot-token';
const ADMIN_TOKEN = 'test-admin-token';
const NEARBY = { kind: 'nearby', ref: 'bubble-1' };
const PAGE = '<html><body><audio src="song.mp3" controls></audio></body></html>';
const owner = { signedIn: true, identifier: 'uuid-owner', name: 'owner' };
const guest = { signedIn: false, name: 'Visitor' };
const asOwner = { person: owner, inChat: true, chat: NEARBY };

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Media = { name: string; type: string; bytes: number | Uint8Array };

const bytes = (size: number, fill = 7) => new Uint8Array(size).fill(fill);

async function send(handler: unknown, body: unknown, media: Media[] = [], options: { id?: string; token?: string; method?: string } = {}) {
  let payload: BodyInit;
  const headers: Record<string, string> = { Authorization: `Bearer ${options.token ?? BOT_TOKEN}` };
  if (media.length > 0) {
    const form = new FormData();
    form.append('request', JSON.stringify(body));
    for (const file of media) form.append('media', new Blob([typeof file.bytes === 'number' ? bytes(file.bytes) : file.bytes], { type: file.type }), file.name);
    payload = form;
  } else {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const request = new NextRequest('http://localhost:3333/api/artifacts', { method: options.method ?? 'POST', headers, body: payload });
  const response = await (handler as Handler)(request, { params: Promise.resolve({ id: options.id ?? '' }) });
  return { status: response.status, body: await response.json() };
}

const makeBody = (extra: object = {}) => ({ botId: 'bot1', person: owner, chat: NEARBY, title: 'My song', kind: 'page', content: PAGE, ...extra });
const changeBody = (extra: object = {}) => ({ botId: 'bot1', person: owner, chat: NEARBY, ...extra });
const SONG = { name: 'song.mp3', type: 'audio/mpeg', bytes: 1000 };
const COVER = { name: 'cover.png', type: 'image/png', bytes: 200 };

async function makeWithSong(media: Media[] = [SONG], who: object = owner) {
  const res = await send(make, makeBody({ person: who }), media);
  expect(res.status).toBe(200);
  return res.body;
}

const versionRow = (artifactId: string, number: number) => db.versions.find((v) => v.artifactId === artifactId && v.number === number)!;

describe('artifact media (#1510)', () => {
  const env = { bot: process.env.BOT_SERVICE_TOKEN, admin: process.env.ADMIN_API_TOKEN };
  beforeAll(() => {
    process.env.BOT_SERVICE_TOKEN = BOT_TOKEN;
    process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  });
  afterAll(() => {
    process.env.BOT_SERVICE_TOKEN = env.bot;
    process.env.ADMIN_API_TOKEN = env.admin;
  });
  beforeEach(() => {
    db.reset();
    resetPruneClock();
    addUser('owner');
    addBot('bot1', 'Scout');
    (checkBotAccess as jest.Mock).mockReset().mockResolvedValue({ allowed: true, code: 'allowed', reason: null });
    (loadBotPrivacy as jest.Mock).mockReset().mockResolvedValue({ universeHides: false, choice: 'follow', hidden: false });
  });

  describe('make', () => {
    it('stores a song beside the page, so the page plays it by its name', async () => {
      const made = await makeWithSong();
      const row = versionRow(made.artifact.id, 1);
      expect(row.fileKey).toMatch(new RegExp(`^artifacts/${made.artifact.id}/v1-[0-9a-f]{24}/index\\.html$`));
      expect(row.media).toEqual([{ name: 'song.mp3', contentType: 'audio/mpeg', sizeBytes: 1000, key: mediaKeyFor(row.fileKey, 'song.mp3') }]);
      expect(db.files.get(mediaKeyFor(row.fileKey, 'song.mp3'))).toEqual(bytes(1000));
      // The bot hears what the version carries, never where it is stored
      expect(made.version.media).toEqual([{ name: 'song.mp3', contentType: 'audio/mpeg', sizeBytes: 1000 }]);
      expect(JSON.stringify(made)).not.toContain(row.fileKey);
    });

    it('still takes plain JSON, with no media', async () => {
      const res = await send(make, makeBody());
      expect(res.status).toBe(200);
      expect(res.body.version.media).toEqual([]);
    });

    it('turns down media over the limit a super admin set, and stores nothing', async () => {
      db.settings.set('bot-limits', { artifacts: { media: 0.001 } });
      const res = await send(make, makeBody(), [{ ...SONG, bytes: 2000 }]);
      expect(res).toMatchObject({ status: 413, body: { error: 'media_too_large', message: 'One version can carry up to 1 KB of songs, images and videos.' } });
      expect(db.artifacts).toHaveLength(0);
      expect(db.files.size).toBe(0);
    });

    it('lets no media in when the limit is 0', async () => {
      db.settings.set('bot-limits', { artifacts: { media: 0 } });
      const res = await send(make, makeBody(), [SONG]);
      expect(res).toMatchObject({ status: 413, body: { error: 'media_off' } });
      // A page without media is still fine
      expect((await send(make, makeBody())).status).toBe(200);
    });

    it('takes songs, images and videos only, under a plain name that matches the type', async () => {
      expect((await send(make, makeBody(), [{ name: 'page.html', type: 'text/html', bytes: 10 }])).body.error).toBe('media_type_not_allowed');
      expect((await send(make, makeBody(), [{ name: 'draw.svg', type: 'image/svg+xml', bytes: 10 }])).body.error).toBe('media_type_not_allowed');
      expect((await send(make, makeBody(), [{ name: 'song.html', type: 'audio/mpeg', bytes: 10 }])).body.error).toBe('media_type_mismatch');
      expect((await send(make, makeBody(), [{ name: '../song.mp3', type: 'audio/mpeg', bytes: 10 }])).body.error).toBe('invalid_media_name');
      expect((await send(make, makeBody(), [{ name: 'index.mp3', type: 'audio/mpeg', bytes: 10 }])).body.error).toBe('invalid_media_name');
      expect((await send(make, makeBody(), [{ ...SONG, bytes: 0 }])).body.error).toBe('empty_media');
      expect((await send(make, makeBody(), [SONG, SONG])).body.error).toBe('duplicate_media');
      expect(db.files.size).toBe(0);
    });

    it('puts media in pages and mini apps only', async () => {
      const res = await send(make, makeBody({ kind: 'markdown', content: '# Song' }), [SONG]);
      expect(res).toMatchObject({ status: 422, body: { error: 'media_not_allowed' } });
    });

    it('removes the page and its media when the database write fails', async () => {
      const original = db.artifacts.push;
      db.artifacts.push = () => {
        throw new Error('database is down');
      };
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = await send(make, makeBody(), [SONG, COVER]);
      db.artifacts.push = original;
      expect(res.status).toBe(500);
      expect(db.files.size).toBe(0);
    });

    it('removes what it stored when one of the media cannot be stored', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const put = jest.spyOn(fakeFiles, 'put').mockImplementation(async (key, body) => {
        if (key.endsWith('cover.png')) throw new Error('bucket down');
        db.files.set(key, body);
      });
      const res = await send(make, makeBody(), [SONG, COVER]);
      put.mockRestore();
      expect(res.status).toBe(500);
      expect(db.files.size).toBe(0);
      expect(db.artifacts).toHaveLength(0);
    });

    it("removes the new version's media when a change cannot be saved", async () => {
      const made = await makeWithSong();
      db.failNextVersionCreate = true;
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = await send(change, changeBody(), [COVER], { id: made.artifact.id });
      expect(res.status).toBe(500);
      expect(db.files.size).toBe(2);
    });
  });

  describe('change', () => {
    it('keeps the media in the new version when only the page changes', async () => {
      const made = await makeWithSong([SONG, COVER]);
      const res = await send(change, changeBody({ edits: [{ old: 'controls', new: 'controls loop' }] }), [], { id: made.artifact.id });
      expect(res.status).toBe(200);
      const [v1, v2] = [versionRow(made.artifact.id, 1), versionRow(made.artifact.id, 2)];
      expect(v2.media.map((file: { name: string }) => file.name)).toEqual(['cover.png', 'song.mp3']);
      // A folder of its own: the old version still plays its own copy
      expect(mediaKeyFor(v2.fileKey, 'song.mp3')).not.toBe(mediaKeyFor(v1.fileKey, 'song.mp3'));
      expect(db.files.get(mediaKeyFor(v2.fileKey, 'song.mp3'))).toEqual(bytes(1000));
      expect(db.files.has(mediaKeyFor(v1.fileKey, 'song.mp3'))).toBe(true);
    });

    it('adds, replaces and drops media, with or without a change to the page', async () => {
      const made = await makeWithSong([SONG, COVER]);
      const res = await send(change, changeBody({ dropMedia: ['cover.png'] }), [{ name: 'song.mp3', type: 'audio/mpeg', bytes: bytes(500, 9) }, { name: 'clip.mp4', type: 'video/mp4', bytes: 300 }], { id: made.artifact.id });
      expect(res.status).toBe(200);
      const v2 = versionRow(made.artifact.id, 2);
      expect(v2.media.map((file: { name: string; sizeBytes: number }) => [file.name, file.sizeBytes])).toEqual([['clip.mp4', 300], ['song.mp3', 500]]);
      expect(db.files.get(mediaKeyFor(v2.fileKey, 'song.mp3'))).toEqual(bytes(500, 9));
      // The page itself is the same as before
      expect(db.files.get(v2.fileKey)).toBe(PAGE);
    });

    it('still needs something to change', async () => {
      const made = await makeWithSong();
      expect((await send(change, changeBody(), [], { id: made.artifact.id })).body.error).toBe('edits_or_content');
      expect((await send(change, changeBody({ content: PAGE, edits: [{ old: 'a', new: 'b' }] }), [], { id: made.artifact.id })).body.error).toBe('edits_or_content');
    });

    it('says when a dropped name is not there', async () => {
      const made = await makeWithSong();
      const res = await send(change, changeBody({ dropMedia: ['nope.mp3'] }), [], { id: made.artifact.id });
      expect(res).toMatchObject({ status: 422, body: { error: 'media_not_found' } });
    });

    it('counts the media it keeps toward the limit', async () => {
      const made = await makeWithSong([{ ...SONG, bytes: 800 }]);
      db.settings.set('bot-limits', { artifacts: { media: 0.001 } });
      const res = await send(change, changeBody(), [{ name: 'two.mp3', type: 'audio/mpeg', bytes: 300 }], { id: made.artifact.id });
      expect(res.body.error).toBe('media_too_large');
      expect(db.versions).toHaveLength(1);
    });

    it('works on a version saved before media, with the old kind of key', async () => {
      const made = await makeWithSong([]);
      const v1 = versionRow(made.artifact.id, 1);
      const oldKey = `artifacts/${made.artifact.id}/v1-${'a'.repeat(24)}.html`;
      db.files.set(oldKey, db.files.get(v1.fileKey)!);
      db.files.delete(v1.fileKey);
      Object.assign(v1, { fileKey: oldKey, media: undefined });
      const res = await send(change, changeBody(), [SONG], { id: made.artifact.id });
      expect(res.status).toBe(200);
      expect(res.body.version.media).toEqual([{ name: 'song.mp3', contentType: 'audio/mpeg', sizeBytes: 1000 }]);
    });
  });

  it('tells the bot which media a version carries when it reads it', async () => {
    const made = await makeWithSong();
    const res = await send(read, { botId: 'bot1', person: owner, chat: NEARBY }, [], { id: made.artifact.id });
    expect(res.body.version.media).toEqual([{ name: 'song.mp3', contentType: 'audio/mpeg', sizeBytes: 1000 }]);
  });

  it('only the make and change routes take a form', async () => {
    const made = await makeWithSong();
    const res = await send(read, { botId: 'bot1', person: owner, chat: NEARBY }, [SONG], { id: made.artifact.id });
    expect(res.status).toBe(400);
  });

  it('opens a version for the game with its media listed', async () => {
    const made = await makeWithSong();
    const res = await send(open, { viewer: asOwner }, [], { id: made.artifact.id, token: ADMIN_TOKEN });
    expect(res.body.version.media).toHaveLength(1);
    expect(res.body.version.url).toMatch(/\/index\.html$/);
  });

  it('a restore carries the media of the version it restores', async () => {
    const made = await makeWithSong();
    await send(change, changeBody({ dropMedia: ['song.mp3'] }), [], { id: made.artifact.id });
    const res = await send(restore, { viewer: asOwner, number: 1 }, [], { id: made.artifact.id, token: ADMIN_TOKEN });
    expect(res.status).toBe(200);
    const v3 = versionRow(made.artifact.id, 3);
    expect(v3.media.map((file: { name: string }) => file.name)).toEqual(['song.mp3']);
    expect(db.files.get(mediaKeyFor(v3.fileKey, 'song.mp3'))).toEqual(bytes(1000));
  });

  it('a copy has its own media, which stay when the original is deleted', async () => {
    const made = await makeWithSong();
    const copied = await send(copy, { viewer: asOwner }, [], { id: made.artifact.id, token: ADMIN_TOKEN });
    expect(copied.status).toBe(200);
    await send(remove, { viewer: asOwner }, [], { id: made.artifact.id, token: ADMIN_TOKEN, method: 'DELETE' });
    const copyRow = versionRow(copied.body.artifact.id, 1);
    expect([...db.files.keys()].sort()).toEqual([copyRow.fileKey, mediaKeyFor(copyRow.fileKey, 'song.mp3')].sort());
  });

  it('deleting an artifact removes the media of every version', async () => {
    const made = await makeWithSong();
    await send(change, changeBody(), [COVER], { id: made.artifact.id });
    expect(db.files.size).toBe(5);
    const res = await send(remove, { viewer: asOwner }, [], { id: made.artifact.id, token: ADMIN_TOKEN, method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(db.files.size).toBe(0);
  });

  it("a guest's artifact goes with its media when its day is over", async () => {
    const made = await makeWithSong([SONG], guest);
    db.artifacts.find((a) => a.id === made.artifact.id)!.expiresAt = new Date(Date.now() - 1000);
    expect(await pruneExpired({ files: fakeFiles, now: new Date() })).toBe(1);
    expect(db.files.size).toBe(0);
  });
});

describe('media rules', () => {
  it('keeps every new version in a folder of its own', () => {
    const key = newFileKey('a1', 3, 'app');
    expect(key).toMatch(/^artifacts\/a1\/v3-[0-9a-f]{24}\/index\.html$/);
    expect(mediaKeyFor(key, 'song.mp3')).toBe(key.replace('index.html', 'song.mp3'));
  });

  it('serves a media file with its plain type', () => {
    expect(checkMediaFile('Song_1.MP3', 'audio/mpeg; charset=binary', 'app')).toBe('audio/mpeg');
    expect(() => checkMediaFile('a b.mp3', 'audio/mpeg', 'app')).toThrow('cannot be a media name');
  });

  it('lets an upload take the place of a kept file with the same name', () => {
    const kept = [{ name: 'song.mp3', contentType: 'audio/mpeg', sizeBytes: 900, key: 'k/song.mp3' }];
    const merged = mergeMedia(kept, [{ name: 'song.mp3', contentType: 'audio/mpeg', body: bytes(950) }], [], 'page', 1000);
    expect(merged.keep).toEqual([]);
    expect(merged.add).toHaveLength(1);
  });
});
