/**
 * The meter's books (game #1998, Brick 7): the migration, run on a throwaway database built from every migration before it.
 * Nothing that exists today is touched or copied in, and from then on the database itself keeps a figure to the four marks, an
 * event to one row per id, a gift apart from extra usage to be billed, and the books whole after a person or a bot is gone.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Row = Record<string, unknown>;
type Result = {
  before: { users: Row[]; bots: Row[]; usage: Row[]; settings: Row[] };
  after: { users: Row[]; bots: Row[]; usage: Row[]; settings: Row[] };
  countsAfterMigration: { events: number; reservations: number; grants: number };
  checks: Record<string, boolean>;
  keptAfterDeletes: Row[];
  grantsAfterPersonGone: number;
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-meter-ledger-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('the meter’s books: the migration', () => {
  it('leaves every account, bot, usage row and saved setting that exists today as it was', () => {
    expect(result.before.users).toHaveLength(2);
    expect(result.before.bots).toHaveLength(2);
    expect(result.before.usage).toHaveLength(1);
    expect(result.before.settings).toHaveLength(1);
    expect(result.after).toEqual(result.before);
  });

  it('starts empty: nothing is copied in, no past usage is guessed, nobody is given extra usage', () => {
    expect(result.countsAfterMigration).toEqual({ events: 0, reservations: 0, grants: 0 });
  });
});

describe('the meter’s books: what the database keeps', () => {
  it('keeps an event to one row per id', () => {
    expect(result.checks.firstEvent).toBe(true);
    expect(result.checks.sameEventIdTwice).toBe(false);
  });

  it('keeps a figure to the four marks, and no price to be taken as 0 when it is not known', () => {
    expect(result.checks.everyMark).toBe(true);
    expect(result.checks.anotherMark).toBe(false);
    expect(result.checks.unknownPriceIsEmpty).toBe(true);
    expect(result.checks.realZero).toBe(true);
  });

  it('knows only its own kinds, pools and payers, never a negative amount, and a person only as a person, a guest or unknown', () => {
    expect(result.checks).toMatchObject({ anotherKind: false, anotherPool: false, anotherPayer: false, negativeQuantity: false, negativeCost: false, nobodyInParticular: false });
    expect(result.checks).toMatchObject({ unknownPerson: true, guest: true });
  });

  it('keeps a reservation to one row per key, for something, in a state it knows', () => {
    expect(result.checks).toMatchObject({ twoReservationsOneKey: false, reservationOfNothing: false, reservationInAnotherState: false });
  });

  it('records a grant once under its key, as a gift or as extra usage to be billed, and as a multiple of 2 or more or no limit, never both or neither', () => {
    expect(result.checks).toMatchObject({ giftIsAccepted: true, sameGrantKeyTwice: false, toBillIsAccepted: true, noLimitIsAccepted: true });
    expect(result.checks).toMatchObject({ noLimitAndAMultiple: false, neitherMultipleNorNoLimit: false, oneTimesIsNotExtra: false, anotherSettlement: false });
  });

  it('gives every grant an end, and never says a gift was billed, because a gift is never owed', () => {
    expect(result.checks).toMatchObject({ endsBeforeItStarts: false, giftBilled: false, toBillBilled: true });
  });

  it('keeps the books whole when a bot or a person is deleted: they are not pointed at', () => {
    expect(result.keptAfterDeletes).toEqual([{ event_id: 'keep1', bot_id: 'brick1', person_key: 'person:sara' }]);
    expect(result.grantsAfterPersonGone).toBe(4);
  });
});
