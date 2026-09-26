/** @jest-environment jsdom */
import {
  REMEMBERED_PAGE_KEY,
  forgetRememberedPage,
  parseBridgeMessage,
  rememberPage,
  rememberedPageFor,
  roomRevisionFromUrl,
} from '@/lib/orbit-bridge';

const GAME = 'https://play.example.test';
const parent = {} as Window;
const expected = { origin: GAME, source: parent };
const revision = 'rev-aaaaaaaaaaaaaaaa';

const navigate = {
  type: 'orbit-navigate',
  version: 1,
  requestId: 'r1',
  roomRevision: revision,
  intent: 'new-universe',
};

describe('parseBridgeMessage', () => {
  it('accepts init, navigate and event messages from the game window', () => {
    expect(parseBridgeMessage({ origin: GAME, source: parent, data: { type: 'orbit-bridge-init', version: 1, roomRevision: revision, capabilities: ['navigate'] } }, expected)?.kind).toBe('init');
    expect(parseBridgeMessage({ origin: GAME, source: parent, data: navigate }, expected)?.kind).toBe('navigate');
    expect(parseBridgeMessage({ origin: GAME, source: parent, data: { type: 'orbit-event', version: 1, requestId: 'r2', roomRevision: revision, topic: 'universes' } }, expected)?.kind).toBe('event');
  });

  it('keeps an intent it does not know, so it can still answer (with home)', () => {
    expect(parseBridgeMessage({ origin: GAME, source: parent, data: { ...navigate, intent: 'something-new' } }, expected)?.kind).toBe('navigate');
  });

  it('rejects another origin', () => {
    expect(parseBridgeMessage({ origin: 'https://evil.example.test', source: parent, data: navigate }, expected)).toBeNull();
  });

  it('rejects another window', () => {
    expect(parseBridgeMessage({ origin: GAME, source: {} as Window, data: navigate }, expected)).toBeNull();
  });

  it('rejects another version', () => {
    expect(parseBridgeMessage({ origin: GAME, source: parent, data: { ...navigate, version: 2 } }, expected)).toBeNull();
  });

  it('rejects malformed payloads and unknown messages', () => {
    expect(parseBridgeMessage({ origin: GAME, source: parent, data: { ...navigate, roomRevision: 'short' } }, expected)).toBeNull();
    expect(parseBridgeMessage({ origin: GAME, source: parent, data: { ...navigate, requestId: undefined } }, expected)).toBeNull();
    expect(parseBridgeMessage({ origin: GAME, source: parent, data: { type: 'orbit-event', version: 1, requestId: 'r', roomRevision: revision, topic: 'grant-xp' } }, expected)).toBeNull();
    expect(parseBridgeMessage({ origin: GAME, source: parent, data: { type: 'orbit-close', version: 1 } }, expected)).toBeNull();
    expect(parseBridgeMessage({ origin: GAME, source: parent, data: 'orbit-navigate' }, expected)).toBeNull();
  });
});

describe('remembered page', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('is kept for the same room revision only', () => {
    rememberPage(window.sessionStorage, revision, '/admin/universes');
    expect(rememberedPageFor(window.sessionStorage, revision)).toBe('/admin/universes');
    expect(rememberedPageFor(window.sessionStorage, 'rev-bbbbbbbbbbbbbbbb')).toBeNull();
    expect(rememberedPageFor(window.sessionStorage, null)).toBeNull();
  });

  it('never remembers the login page or anything outside Orbit', () => {
    rememberPage(window.sessionStorage, revision, '/admin/login?redirect=/admin');
    expect(window.sessionStorage.getItem(REMEMBERED_PAGE_KEY)).toBeNull();
    rememberPage(window.sessionStorage, revision, 'https://evil.example.test/admin');
    expect(window.sessionStorage.getItem(REMEMBERED_PAGE_KEY)).toBeNull();
  });

  it('ignores a tampered value and can be forgotten', () => {
    window.sessionStorage.setItem(REMEMBERED_PAGE_KEY, JSON.stringify({ roomRevision: revision, path: '//evil.example.test' }));
    expect(rememberedPageFor(window.sessionStorage, revision)).toBeNull();
    rememberPage(window.sessionStorage, revision, '/admin/stars');
    forgetRememberedPage(window.sessionStorage);
    expect(rememberedPageFor(window.sessionStorage, revision)).toBeNull();
  });

  it('reads the room revision the game put on the login URL', () => {
    expect(roomRevisionFromUrl(new URL(`https://orbit.example.test/admin/login?rev=${revision}`))).toBe(revision);
    expect(roomRevisionFromUrl(new URL('https://orbit.example.test/admin/login?rev=short'))).toBeNull();
    expect(roomRevisionFromUrl(new URL('https://orbit.example.test/admin/login'))).toBeNull();
  });
});
