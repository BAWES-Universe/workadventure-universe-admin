/**
 * "A bot can exist without a room" (game #1992) migration: runs the real migrations on a throwaway database. Every bot
 * that exists today comes through untouched and gets no owner, a bot can now be stored with an owner and no room (a
 * Brick), the database holds every bot to exactly one of the two, and deleting a room still deletes its room bots.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Row = Record<string, unknown>;
type Hanging = { rules: Row[]; apps: Row[]; memory: Row[]; chats: Row[] };
type Result = {
  before: { bots: Row[] } & Hanging;
  after: { bots: Row[] } & Hanging;
  checks: Record<string, boolean>;
  botsBeforeDeletes: string[];
  afterRoomGone: { bots: string[]; rules: number; apps: number };
  afterMakerGone: Row[];
  afterOwnerGone: string[];
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-bot-without-room-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('a bot can exist without a room: the migration', () => {
  it('leaves every column of every bot that exists today as it was: id, room, look, behaviour, personality, keys, voice and limits', () => {
    expect(result.before.bots).toHaveLength(2);
    const withoutOwner = result.after.bots.map(({ owner_id: _owner, ...rest }) => rest);
    expect(withoutOwner).toEqual(result.before.bots);
    expect(result.after.bots.map((bot) => bot.room_id)).toEqual(['room1', 'room2']);
  });

  it('keeps what hangs from them: who may use them, their apps, their memory and their chats', () => {
    const { bots: _before, ...hangingBefore } = result.before;
    const { bots: _after, ...hangingAfter } = result.after;
    expect(hangingAfter).toEqual(hangingBefore);
    expect(hangingAfter.rules).toHaveLength(1);
    expect(hangingAfter.apps).toHaveLength(1);
    expect(hangingAfter.memory).toHaveLength(1);
    expect(hangingAfter.chats).toHaveLength(1);
  });

  it('converts nobody: today’s bots get no owner, even though each has a "made by"', () => {
    expect(result.before.bots.map((bot) => bot.created_by_id)).toEqual(['maker', 'maker']);
    expect(result.after.bots.map((bot) => bot.owner_id)).toEqual([null, null]);
  });

  it('stores a room bot as today, and a Brick: a bot with an owner and no room', () => {
    expect(result.checks).toMatchObject({ roomBotAsToday: true, brick: true });
    expect(result.botsBeforeDeletes).toEqual(['bot1', 'bot2', 'bot3', 'brick1']);
  });

  it('holds a bot to exactly one home: never neither, never both, and only an owner who exists', () => {
    expect(result.checks).toMatchObject({
      neitherRoomNorOwner: false,
      roomAndOwner: false,
      unknownOwner: false,
      brickIntoRoom: false,
      roomBotOutOfItsRoom: false,
      roomBotGivenAnOwner: false,
    });
  });

  it('deletes a room’s bots with the room, as today, and what hangs from them; a Brick is in no room and stays', () => {
    expect(result.afterRoomGone).toEqual({ bots: ['bot2', 'brick1'], rules: 0, apps: 0 });
  });

  it('keeps a room bot in its room when the account that made it goes: "made by" is not ownership', () => {
    expect(result.afterMakerGone).toEqual([{ id: 'bot2', room_id: 'room2', created_by_id: null, owner_id: null }]);
  });

  it('removes a Brick with its owner’s account', () => {
    expect(result.afterOwnerGone).toEqual(['bot2']);
  });
});
