import { parseBridgeMessage } from '@/lib/orbit-bridge';

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

  it('accepts the view the frame is in, on init and when it changes', () => {
    expect(parseBridgeMessage({ origin: GAME, source: parent, data: { type: 'orbit-bridge-init', version: 1, roomRevision: revision, capabilities: [], view: 'full' } }, expected)).toEqual(
      expect.objectContaining({ kind: 'init', message: expect.objectContaining({ view: 'full' }) }),
    );
    expect(parseBridgeMessage({ origin: GAME, source: parent, data: { type: 'orbit-view', version: 1, view: 'compact' } }, expected)?.kind).toBe('view');
    expect(parseBridgeMessage({ origin: GAME, source: parent, data: { type: 'orbit-view', version: 1, view: 'huge' } }, expected)).toBeNull();
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

describe('orbit-quest-state', () => {
  const entry = { id: 'welcome.explore', title: 'Find the Courtyard', status: 'tracked', stamp: 'explorer', giver: 'Nova', room: 'Lobby' };
  const state = (entries: unknown[], extra: Record<string, unknown> = {}) => ({
    origin: GAME,
    source: parent,
    data: { type: 'orbit-quest-state', version: 1, roomRevision: revision, entries, ...extra },
  });

  it('accepts a bounded quest log', () => {
    expect(parseBridgeMessage(state([entry, { ...entry, id: 'b', status: 'done', stamp: undefined, giver: undefined }]), expected)).toEqual(
      expect.objectContaining({ kind: 'quest-state', message: expect.objectContaining({ entries: expect.arrayContaining([expect.objectContaining({ id: 'b' })]) }) }),
    );
    expect(parseBridgeMessage(state([]), expected)?.kind).toBe('quest-state');
  });

  it("accepts the game's message exactly as it sends it (no revision)", () => {
    const fromGame = { origin: GAME, source: parent, data: { type: 'orbit-quest-state', version: 1, entries: [entry] } };
    expect(parseBridgeMessage(fromGame, expected)).toEqual({ kind: 'quest-state', message: { type: 'orbit-quest-state', version: 1, entries: [entry] } });
  });

  it.each([
    ['more than eight entries', state(Array.from({ length: 9 }, (_, index) => ({ ...entry, id: `q${index}` })))],
    ['an over-long title', state([{ ...entry, title: 'x'.repeat(81) }])],
    ['an over-long id', state([{ ...entry, id: 'x'.repeat(65) }])],
    ['an over-long room', state([{ ...entry, room: 'x'.repeat(81) }])],
    ['an unknown status', state([{ ...entry, status: 'failed' }])],
    ['an unknown stamp', state([{ ...entry, stamp: 'core' }])],
    ['a malformed revision', state([entry], { roomRevision: 'not-a-revision' })],
    ['entries that are not a list', state([], { entries: 'lots' })],
  ])('ignores %s', (_, message) => {
    expect(parseBridgeMessage(message, expected)).toBeNull();
  });

  it('ignores it from another origin', () => {
    expect(parseBridgeMessage({ ...state([entry]), origin: 'https://evil.example.test' }, expected)).toBeNull();
  });
});
