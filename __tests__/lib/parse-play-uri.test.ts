/**
 * Every route that finds a room from a play address (entering a room, the ban check, the map) compares the slugs with
 * the database, which stores them as written. The address keeps non-ASCII slugs percent-encoded.
 */
import { buildPlayUri, parsePlayUri } from '@/lib/utils';

describe('parsePlayUri', () => {
  it('reads plain slugs as before', () => {
    expect(parsePlayUri('https://play.test/@/bawes/office/lobby')).toEqual({
      universe: 'bawes',
      world: 'office',
      room: 'lobby',
      domain: 'play.test',
    });
  });

  it('reads non-ASCII and percent-encoded slugs as the database has them', () => {
    expect(parsePlayUri('https://play.test/@/bawes/caf%C3%A9/sal%C3%B3n')).toMatchObject({ world: 'café', room: 'salón' });
    expect(parsePlayUri('https://play.test/@/bawes/café/lobby')).toMatchObject({ world: 'café' });
    expect(parsePlayUri('https://play.test/@/bawes/50%25-off/lobby')).toMatchObject({ world: '50%-off' });
  });

  it('round-trips with buildPlayUri', () => {
    const uri = buildPlayUri('https://play.test', 'بيت', 'café', 'lobby');
    expect(parsePlayUri(uri)).toMatchObject({ universe: 'بيت', world: 'café', room: 'lobby' });
  });

  it('refuses a malformed address like any other that is not a room', () => {
    expect(() => parsePlayUri('https://play.test/@/bawes/%E0%A4%A/lobby')).toThrow();
    expect(() => parsePlayUri('https://play.test/rooms/lobby')).toThrow('Invalid playUri format');
  });
});
