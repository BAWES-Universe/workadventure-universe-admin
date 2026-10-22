/**
 * Visitors (#531): the check, relink and undo scripts, run as written on a throwaway database built from every migration.
 * Only visits whose unverified id belongs to exactly one signed-in account move onto it; nothing else changes, no visit
 * is added or deleted, running it twice moves nothing more, and the undo puts every visit back exactly.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Visit = { id: string; user_uuid: string | null; user_id: string | null; user_name: string | null; user_email: string | null; is_guest: boolean; is_authenticated: boolean; room_id: string };
type Counts = Record<string, number | null>;
let result: {
  check: Counts & { by_kind: Counts; complete: boolean; people_whose_visits_move: number; their_visits_before: number; their_visits_after: number };
  checkAfter: Counts & { by_kind: Counts; complete: boolean };
  before: Visit[];
  after: Visit[];
  afterUndo: Visit[];
  peopleBefore: Array<{ room_id: string; people: number; visits: number }>;
  peopleAfter: Array<{ room_id: string; people: number; visits: number }>;
  log: Array<{ room_access_id: string; user_id: string; old_user_uuid: string; old_user_id: string | null; old_user_name: string | null; old_is_guest: boolean; undone_at: string | null }>;
  relink: Counts;
  relinkAgain: Counts;
  undo: Counts;
  undoAgain: Counts;
  ids: { mona: string };
};

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-unverified-visits-relink.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  result = JSON.parse(output.trim().split('\n').pop() as string);
}, 150_000);

const byId = (visits: Visit[]) => Object.fromEntries(visits.map((visit) => [visit.id, visit]));
const MOVED = ['mona-unverified-1', 'mona-unverified-2', 'noemail-unverified'];

describe('unverified visits check (read-only)', () => {
  it('sorts every unverified visit into exactly one group, and counts as movable exactly what the relink moves', () => {
    expect(result.check.complete).toBe(true);
    expect(result.check.by_kind).toEqual({
      one_account: 3,
      more_than_one_account: 1,
      no_account: 1,
      guest_marked_account_only: 1,
      already_has_an_account: 1,
      other_format: 1,
    });
    expect(result.check.by_kind.one_account).toBe(result.relink.moved);
  });

  it('counts the people whose visits move and their visit totals before and after', () => {
    expect(result.check.people_whose_visits_move).toBe(2);
    // Mona has 2 visits under her account (one signed in, one from before #421), Nemo none; 3 move onto them.
    expect(result.check.their_visits_before).toBe(2);
    expect(result.check.their_visits_after).toBe(5);
  });
});

describe('unverified visits relink', () => {
  it('moves a visit made with the account email onto that account, as visits were saved before #421', () => {
    const after = byId(result.after);
    expect(after['mona-unverified-1']).toMatchObject({ user_id: 'mona', user_uuid: 'sub-mona', user_name: 'Mona', user_email: 'mona@example.test', is_guest: false, is_authenticated: false });
    expect(after['mona-unverified-2']).toMatchObject({ user_id: 'mona', user_name: 'Mona', is_authenticated: false });
  });

  it('moves a visit made with the uuid of an account that has no email', () => {
    expect(byId(result.after)['noemail-unverified']).toMatchObject({ user_id: 'noemail', user_uuid: 'sub-noemail', user_name: 'Nemo' });
  });

  it('leaves alone an id two accounts make, one no account makes, one only a guest-marked account makes, an odd one and one already linked', () => {
    const before = byId(result.before);
    const after = byId(result.after);
    for (const id of ['twin-unverified', 'gone-unverified', 'oldguest-unverified', 'odd-format', 'already-linked']) {
      expect(after[id]).toEqual(before[id]);
    }
  });

  it('leaves real guests, signed-in visits and visits from before #421 exactly as they were', () => {
    const before = byId(result.before);
    const after = byId(result.after);
    for (const id of ['guest-nova', 'guest-nameless', 'mona-signed-in', 'mona-before-421']) {
      expect(after[id]).toEqual(before[id]);
    }
  });

  it('changes only the moved visits, adds or deletes none, and keeps every room visit total', () => {
    const before = byId(result.before);
    const changed = result.after.filter((visit) => JSON.stringify(visit) !== JSON.stringify(before[visit.id])).map((visit) => visit.id);
    expect(changed.sort()).toEqual(MOVED);
    expect(result.after).toHaveLength(result.before.length);
    expect(result.relink).toMatchObject({ moved: 3, people: 2, logged: 3, visits_before: 12, visits_after: 12, unverified_before: 8, unverified_left: 5 });
    expect(result.peopleAfter.map((room) => room.visits)).toEqual(result.peopleBefore.map((room) => room.visits));
  });

  it('joins split cards: one person fewer in the room where Mona had a signed-in and an unverified card', () => {
    expect(result.peopleBefore).toEqual([
      { room_id: 'r1', people: 9, visits: 10 },
      { room_id: 'r2', people: 2, visits: 2 },
    ]);
    // r1: Mona's unverified card joins hers and Nemo's moves onto his account (still one card). r2: her only visit there.
    expect(result.peopleAfter).toEqual([
      { room_id: 'r1', people: 8, visits: 10 },
      { room_id: 'r2', people: 2, visits: 2 },
    ]);
  });

  it('records what each moved visit held before', () => {
    expect(result.log.map((row) => row.room_access_id)).toEqual(MOVED);
    expect(result.log[1]).toMatchObject({ user_id: 'mona', old_user_uuid: result.ids.mona, old_user_id: null, old_user_name: 'Typed', old_is_guest: true, undone_at: null });
  });

  it('moves nothing more when run again', () => {
    expect(result.relinkAgain).toMatchObject({ moved: 0, logged: 0, visits_before: 12, visits_after: 12 });
    expect(result.checkAfter.by_kind.one_account).toBeUndefined();
    expect(result.checkAfter.complete).toBe(true);
  });
});

describe('unverified visits undo', () => {
  it('puts every moved visit back exactly as it was, and nothing twice', () => {
    expect(result.undo).toMatchObject({ put_back: 3, visits_before: 12, visits_after: 12, unverified_after: 8 });
    expect(result.afterUndo).toEqual(result.before);
    expect(result.undoAgain).toMatchObject({ put_back: 0 });
  });
});
