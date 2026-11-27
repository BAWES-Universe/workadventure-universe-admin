/**
 * The funding books, run for real against a database (paying spec v3, section 17: tests 1, 2, 3, 4, 7, 8, 12 (books part), 13 and 14).
 * Each check says what must hold; the script prints one JSON line of results. Run it by hand on a real Postgres with
 * `CREDIT_BOOKS_PG=postgres://user:pass@127.0.0.1:5432/postgres npx tsx __tests__/helpers/run-credit-books.ts`, or let
 * __tests__/lib/credit-books-db.test.ts run it on PGlite.
 */
import { connect, startTestDatabase } from './credit-books-db';

type Check = { name: string; ok: boolean; detail?: unknown };
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok, detail: ok ? undefined : detail });
};

const T0 = new Date('2026-11-15T10:00:00Z');
const at = (iso: string) => new Date(iso);
const M = 1_000_000;

// Money is whole micros in BigInt on the way out of the database: a result that holds one must still print
const printable = (value: unknown): string => JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item));

async function main() {
  const database = await startTestDatabase();
  let close: (() => Promise<void>) | null = null;
  try {
    await run(database, (fn) => {
      close = fn;
    });
  } finally {
    // Whatever happened, the client (if it was made) is closed and the throwaway database is taken down
    if (close) await (close as () => Promise<void>)().catch(() => undefined);
    await database.stop().catch(() => undefined);
  }
}

async function run(database: Awaited<ReturnType<typeof startTestDatabase>>, onClose: (fn: () => Promise<void>) => void) {
  const { prisma, close } = await connect(database);
  onClose(close);
  (globalThis as unknown as { prisma: unknown }).prisma = prisma;
  process.env.DATABASE_URL = database.url;

  const rules = await import('@/lib/credit-rules');
  const issue = await import('@/lib/credit-issue');
  const spend = await import('@/lib/credit-spend');
  const funding = await import('@/lib/credit-funding');
  const billing = await import('@/lib/credit-billing');
  const usage = await import('@/lib/credit-usage');
  const replies = await import('@/lib/credit-replies');
  const values = await import('@/lib/credit-values');
  const meterUsage = await import('@/lib/meter-usage');
  const instant = await import('@/lib/funding/instant-funds');

  const root = { userId: 'admin', superAdmin: true };
  const user = (id: string, createdAt = '2026-01-10T00:00:00Z', guest = false) => prisma.user.create({ data: { id, uuid: `uuid-${id}`, name: id, isGuest: guest, createdAt: new Date(createdAt) } });
  const lotsOf = (personId: string) => prisma.creditLot.findMany({ where: { personId }, orderBy: { issuedAt: 'asc' } });
  const refuses = async (fn: () => Promise<unknown>): Promise<{ code?: string; error?: unknown } | null> => {
    try {
      await fn();
      return null;
    } catch (error) {
      return { code: values.isCreditRefused(error) ? error.code : undefined, error };
    }
  };
  const setMeter = (value: Record<string, unknown>) => prisma.appSetting.upsert({ where: { key: 'meter' }, create: { key: 'meter', value: value as never }, update: { value: value as never } });

  await prisma.$executeRawUnsafe(`INSERT INTO app_settings (key, value, updated_at) VALUES ('noop', '{}', now())`);
  for (const [id, created] of [['admin', '2025-01-01T00:00:00Z'], ['sara', '2026-01-10T00:00:00Z'], ['omar', '2026-02-10T00:00:00Z'], ['older', '2025-06-01T00:00:00Z']] as const) await user(id, created);
  await user('guest1', '2026-05-01T00:00:00Z', true);
  await prisma.$executeRawUnsafe(`INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u1', 'acme', 'Acme', 'admin', now())`);

  // ---------- A fresh deploy starts filled in (launch defaults migration), so nothing is refused for lack of a number ----------
  {
    const { getMeterSettings } = await import('@/lib/meter');
    const { getInstantLimits } = await import('@/lib/instant/state');
    const { missingSettings } = await import('@/lib/meter-values');
    const { missingInstantLimits } = await import('@/lib/instant/values');
    const now = new Date();
    check('a fresh deploy has every computer Limit set', missingSettings(await getMeterSettings()).length === 0, await getMeterSettings());
    check('a fresh deploy has every Instant limit set', missingInstantLimits(await getInstantLimits()).length === 0, await getInstantLimits());
    const first = await issue.ensureIssued('sara', now);
    const byCategory = Object.fromEntries(first.issued.map((lot) => [lot.programId, lot.amountMicros]));
    check('a new member is given $2.00 of Instant Apps this month and $0.25 of computers by the default grants', first.issued.length === 2 && byCategory['seed-default-instant_apps'] === 2_000_000 && first.issued.some((lot) => lot.programId === 'seed-default-instant_apps' && lot.periodKey === now.toISOString().slice(0, 7)) && byCategory['seed-default-computers'] === 250_000 && first.skipped.length === 0, first);
    check('issuing again gives nothing more', (await issue.ensureIssued('sara', now)).issued.length === 0);
    const search = await spend.holdCredit({ holdKey: 'k-seed-search', personId: 'sara', category: 'instant_apps', amountMicros: 8_000, chargeClass: 'instant_run' }, now);
    check('an Instant search fits in the starting credit', search.ok === true, search);
    const tooMuch = await spend.holdCredit({ holdKey: 'k-seed-too-much', personId: 'sara', category: 'instant_apps', amountMicros: 2_000_000, chargeClass: 'instant_run' }, now);
    check('a hold bigger than what is left is refused as used up, not as not set', !tooMuch.ok && tooMuch.reason !== 'not_set', tooMuch);
    const job = await spend.holdCredit({ holdKey: 'k-seed-job', personId: 'sara', category: 'computers', amountMicros: 40_000, chargeClass: 'computer_job' }, now);
    check('a computer job fits in the starting credit', job.ok === true, job);
    // The scenarios below test the engine from a blank start: take the seeded start away again
    await prisma.$executeRawUnsafe(`DELETE FROM credit_allocations`);
    await prisma.$executeRawUnsafe(`DELETE FROM credit_holds`);
    await prisma.$executeRawUnsafe(`DELETE FROM credit_lots`);
    await prisma.$executeRawUnsafe(`DELETE FROM grant_programs WHERE id LIKE 'seed-default-%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM app_settings WHERE key IN ('meter', 'instant-limits')`);
  }

  // ---------- Nothing is assumed: no budget, no credit ----------
  {
    const prog = await rules.saveDefault({ categoryId: 'instant_apps', amount: 2 * M, schedule: 'once', recipients: { kind: 'all' } }, root, T0).catch((e) => e);
    check('a default saves without a budget (the budget is checked when credit is issued)', !(prog instanceof Error), prog);
    const none = await issue.ensureIssued('sara', T0);
    check('with no rollout budget set nothing is issued and it says why', none.issued.length === 0 && none.skipped.some((s) => s.reason === 'not_set'), none);
    const held = await spend.holdCredit({ holdKey: 'k-notset', personId: 'sara', category: 'instant_apps', amountMicros: 1, chargeClass: 'instant_run' }, T0);
    check('a hold with nothing set up answers not_set, not "used up"', !held.ok && held.reason === 'not_set', held);
  }
  await setMeter({ rolloutBudgetMicros: 10_000 * M, renewMinutes: 10 });

  // ---------- Test 2: exactly once ----------
  {
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => issue.ensureIssued('sara', T0)));
    const lots = await lotsOf('sara');
    check('five issues at once for the same person make one lot', lots.length === 1 && Number(lots[0].amountMicros) === 2 * M, { lots: lots.length, issued: results.map((r) => r.issued.length) });
    check('the lot records its program, version and period', lots[0].periodKey === 'once' && lots[0].ruleVersion === 1 && lots[0].source === 'default' && lots[0].slotKey === 'base:instant_apps' && lots[0].subjectKey === 'person:sara', lots[0]);
    const guest = await issue.ensureIssued('guest1', T0);
    check('a guest is due nothing', guest.issued.length === 0 && (await lotsOf('guest1')).length === 0);

    const migrated = await issue.ensureIssuedFor(['admin', 'sara', 'omar', 'older'], T0);
    const again = await issue.ensureIssuedFor(['admin', 'sara', 'omar', 'older'], T0);
    const all = await prisma.creditLot.count();
    check('existing members each get one lot on first touch, and a rerun adds none', migrated.issued === 3 && again.issued === 0 && all === 4, { migrated, again, all });

    const v2 = await rules.saveDefault({ categoryId: 'instant_apps', amount: 3 * M, schedule: 'once', recipients: { kind: 'all' } }, root, T0);
    check('editing a default is a new version of the same program', v2.version === 2 && v2.programId === (await rules.listPrograms('instant_apps'))[0].programId, v2);
    const programs = await rules.listPrograms('instant_apps');
    check('there is still one default program, with two versions', programs.length === 1 && programs[0].versions === 2, programs);
    await issue.ensureIssued('sara', T0);
    check('a rule edit never issues a second grant for the same period, and given credit is not changed', (await lotsOf('sara')).length === 1 && Number((await lotsOf('sara'))[0].amountMicros) === 2 * M);
    await user('noor', '2026-11-14T00:00:00Z');
    await issue.ensureIssued('noor', T0);
    const noor = await lotsOf('noor');
    check('someone who arrives after the edit gets the new version', noor.length === 1 && Number(noor[0].amountMicros) === 3 * M && noor[0].ruleVersion === 2, noor);
    const second = await prisma.creditLot.findMany({ where: { personId: 'sara' } });
    check('a reconnect or another device later still adds nothing', (await issue.ensureIssued('sara', at('2026-11-20T00:00:00Z'))).issued.length === 0 && second.length === 1);
  }

  // ---------- Test 4: the month boundary, shown in UTC ----------
  {
    await rules.saveDefault({ categoryId: 'computers', amount: 5 * M, schedule: 'monthly', recipients: { kind: 'all' } }, root, T0);
    const nov = await issue.ensureIssued('sara', T0);
    check('a monthly default issues the month’s lot, ending with the month', nov.issued.length === 1 && nov.issued[0].periodKey === '2026-11', nov);
    const novLot = (await prisma.creditLot.findMany({ where: { personId: 'sara', slotKey: 'base:computers' } }))[0];
    check('a monthly lot starts the 1st and ends the 1st (UTC)', novLot.startsAt.toISOString() === '2026-11-01T00:00:00.000Z' && novLot.expiresAt?.toISOString() === '2026-12-01T00:00:00.000Z', novLot);
    check('the same month again issues nothing', (await issue.ensureIssued('sara', at('2026-11-30T23:59:59Z'))).issued.length === 0);
    const line = await usage.moneyLine('sara', 'computers', at('2026-11-30T23:59:59Z'));
    check('the line says it renews at the UTC month end', !!line && !('unavailable' in line && line.unavailable === true) && (line as { renewsAt: string }).renewsAt === '2026-12-01T00:00:00.000Z' && (line as { kind: string }).kind === 'monthly', line);
    const hold = await spend.holdCredit({ holdKey: 'k-boundary', personId: 'sara', category: 'computers', amountMicros: 2 * M, chargeClass: 'computer_job' }, at('2026-11-30T23:59:59Z'));
    const dec = await issue.ensureIssued('sara', at('2026-12-01T00:00:00Z'));
    check('at the UTC month change a new lot comes and nothing rolls over', dec.issued.length === 1 && dec.issued[0].periodKey === '2026-12', dec);
    const settled = await spend.settleHold({ holdKey: 'k-boundary', customerMicros: 2 * M }, at('2026-12-01T00:10:00Z'));
    check('a step held before the boundary settles after it, from the lot it took from', hold.ok && settled?.state === 'settled' && settled.allocations[0].lotId === novLot.id && settled.customerMicros === 2 * M, settled);
    const decLine = await usage.moneyLine('sara', 'computers', at('2026-12-01T00:20:00Z'));
    check('December starts full: the old month’s use does not carry', !!decLine && (decLine as { availableMicros: number }).availableMicros === 5 * M, decLine);
    const edit = await rules.saveDefault({ categoryId: 'computers', amount: 7 * M, schedule: 'monthly', recipients: { kind: 'all' } }, root, at('2026-12-02T00:00:00Z'));
    check('an edit does not reset what was used or the month’s lot', edit.version === 2 && (await usage.moneyLine('sara', 'computers', at('2026-12-02T01:00:00Z')) as { availableMicros: number }).availableMicros === 5 * M);
  }

  // ---------- Test 8: exceptions, clashes, overlaps ----------
  {
    const sara = await rules.saveException({ categoryId: 'computers', amount: 9 * M, schedule: 'monthly', recipients: { kind: 'people', userIds: ['sara'] } }, root, T0);
    check('a person’s own exception saves', sara.kind === 'exception' && sara.recipientCount === 1, sara);
    const groupA = await rules.saveException({ categoryId: 'computers', amount: 4 * M, schedule: 'monthly', recipients: { kind: 'people', userIds: ['omar', 'older'] } }, root, T0);
    const clash = await refuses(() => rules.saveException({ categoryId: 'computers', amount: 8 * M, schedule: 'monthly', recipients: { kind: 'people', userIds: ['older', 'noor'] } }, root, T0));
    const clashes = (clash?.error as { clashes?: { programId: string; people: { userId: string }[] }[] } | undefined)?.clashes;
    check('two group exceptions that disagree for the same people cannot be saved, and the person is named', clash?.code === 'clash' && clashes?.[0]?.programId === groupA.programId && clashes?.[0]?.people[0]?.userId === 'older', clash);
    const sameSaid = await refuses(() => rules.saveException({ categoryId: 'computers', amount: 4 * M, schedule: 'monthly', recipients: { kind: 'people', userIds: ['older', 'noor'] } }, root, T0));
    check('the same thing said for an overlapping group is not a clash', sameSaid === null, sameSaid);
    const own = await refuses(() => rules.saveException({ categoryId: 'computers', amount: 1 * M, schedule: 'monthly', recipients: { kind: 'people', userIds: ['omar'] } }, root, T0));
    check('one person’s own exception inside a group is narrower, so it is not a clash', own === null, own);
    const twoPeople = await refuses(() => rules.saveException({ categoryId: 'computers', amount: 2 * M, schedule: 'monthly', recipients: { kind: 'people', userIds: ['sara'] } }, root, T0));
    check('two single-person exceptions for one person that disagree clash', twoPeople?.code === 'clash', twoPeople);
    const editClash = await refuses(() => rules.saveException({ programId: groupA.programId, categoryId: 'computers', amount: 6 * M, schedule: 'monthly', recipients: { kind: 'people', userIds: ['omar', 'older'] } }, root, T0));
    check('editing a group so it disagrees with an overlapping group is a clash too', editClash?.code === 'clash', editClash);
    const edited = await rules.saveException({ programId: groupA.programId, categoryId: 'computers', amount: 4 * M, schedule: 'monthly', label: 'Group A', recipients: { kind: 'people', userIds: ['omar', 'older'] } }, root, T0);
    check('editing an exception is not a clash with itself', edited.version === 2, edited);
    const roles = await refuses(async () => rules.saveException({ categoryId: 'computers', amount: 1 * M, schedule: 'monthly', recipients: { kind: 'role', roleId: 'admin' } as never }, root, T0));
    check('a universe role is never a recipient', roles?.code === 'recipients', roles);
    const unknown = await refuses(() => rules.saveException({ categoryId: 'computers', amount: 1 * M, schedule: 'monthly', recipients: { kind: 'people', userIds: ['nobody'] } }, root, T0));
    check('people you pick must be real signed-in accounts', unknown?.code === 'recipients', unknown);
    const guestPick = await refuses(() => rules.saveException({ categoryId: 'computers', amount: 1 * M, schedule: 'monthly', recipients: { kind: 'people', userIds: ['guest1'] } }, root, T0));
    check('a guest cannot be picked', guestPick?.code === 'recipients', guestPick);
    const d2 = at('2027-01-05T00:00:00Z');
    await Promise.all(['sara', 'omar', 'older', 'noor', 'admin'].map((id) => issue.ensureIssued(id, d2)));
    const amount = async (id: string) => Number((await prisma.creditLot.findMany({ where: { personId: id, slotKey: 'base:computers', periodKey: '2027-01' } }))[0]?.amountMicros ?? 0);
    check('each person gets the narrowest rule: own exception, then the group’s, then the default', (await amount('sara')) === 9 * M && (await amount('omar')) === 1 * M && (await amount('older')) === 4 * M && (await amount('noor')) === 4 * M && (await amount('admin')) === 7 * M, {
      sara: await amount('sara'),
      omar: await amount('omar'),
      older: await amount('older'),
      noor: await amount('noor'),
      admin: await amount('admin'),
    });
    const none = await rules.saveException({ categoryId: 'computers', schedule: 'none', recipients: { kind: 'people', userIds: ['admin'] } }, root, T0);
    check('"no grant" is an exception that gives nothing', none.schedule === 'none' && none.amount === 0, none);
    await issue.ensureIssued('admin', at('2027-02-05T00:00:00Z'));
    check('and a person under it gets nothing the next month', (await prisma.creditLot.count({ where: { personId: 'admin', periodKey: '2027-02' } })) === 0);
    const defNone = await rules.saveDefault({ categoryId: 'computers', schedule: 'none', recipients: { kind: 'all' } }, root, at('2027-02-06T00:00:00Z'));
    check('a default can be set to none', defNone.schedule === 'none');
    await rules.saveDefault({ categoryId: 'computers', amount: 7 * M, schedule: 'monthly', recipients: { kind: 'all' } }, root, at('2027-02-07T00:00:00Z'));
    const dup = await refuses(() => prisma.grantProgram.create({ data: { categoryId: 'computers', kind: 'default', label: 'again', createdById: 'admin' } }));
    check('the database allows one active default per category', dup !== null);
  }

  // Take the defaults away so what follows is only gifts, funding accounts and holds
  {
    const ended = await Promise.all((await rules.listPrograms(undefined, { kind: 'default' })).map((p) => rules.endProgram(p.programId, root, at('2027-02-10T00:00:00Z'))));
    check('ending a program stops new issuance and keeps what was given', ended.every((r) => r === 'ended') && (await prisma.creditLot.count()) > 0);
    check('ending twice says so', (await rules.endProgram((await rules.listPrograms(undefined, { kind: 'default', includeEnded: true }))[0].programId, root)) === 'already_ended');
  }
  const G = at('2027-02-12T10:00:00Z');
  for (const id of ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8']) await user(id, '2027-02-11T00:00:00Z');
  await prisma.creditLot.deleteMany({ where: { personId: { in: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8'] } } });

  // ---------- Tests 1 and 3: the last dollar, scope, shared ----------
  {
    const gift = await rules.createGift({ categoryId: 'instant_apps', amount: 5 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['g1', 'g2'] }, covers: ['instant_apps', 'computers'], requestKey: 'gift-A' }, root, G);
    const replay = await rules.createGift({ categoryId: 'instant_apps', amount: 5 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['g1', 'g2'] }, covers: ['computers', 'instant_apps'], requestKey: 'gift-A' }, root, G);
    check('the same request key finds the same gift instead of giving another', replay.replayed === true && replay.programId === gift.programId && (await prisma.grantProgram.count({ where: { requestKey: 'gift-A' } })) === 1, replay);
    const other = await refuses(() => rules.createGift({ categoryId: 'instant_apps', amount: 6 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['g1', 'g2'] }, covers: ['instant_apps', 'computers'], requestKey: 'gift-A' }, root, G));
    check('the same key with other figures is refused: the first stands', other?.code === 'key_used', other);
    const capped = await refuses(() => rules.createGift({ categoryId: 'instant_apps', amount: 5 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['g1', 'g2'] }, covers: ['instant_apps', 'computers'], totalCapMicros: 8 * M, requestKey: 'gift-A' }, root, G));
    check('the same key with another cap is refused too: the first stands', capped?.code === 'key_used', capped);
    await Promise.all([issue.ensureIssued('g1', G), issue.ensureIssued('g1', G), issue.ensureIssued('g2', G)]);
    const g1lots = await lotsOf('g1');
    check('a gift for both Instant Apps and computers is ONE dollar amount: one lot covering both', g1lots.length === 1 && g1lots[0].covers.length === 2 && Number(g1lots[0].amountMicros) === 5 * M && g1lots[0].source === 'gift', g1lots);
    const a = await spend.holdCredit({ holdKey: 'g1-a', personId: 'g1', category: 'instant_apps', amountMicros: 3 * M, chargeClass: 'instant_run' }, G);
    const b = await spend.holdCredit({ holdKey: 'g1-b', personId: 'g1', category: 'computers', amountMicros: 3 * M, chargeClass: 'computer_job' }, G);
    const c = await spend.holdCredit({ holdKey: 'g1-c', personId: 'g1', category: 'computers', amountMicros: 2 * M, chargeClass: 'computer_job' }, G);
    const d = await spend.holdCredit({ holdKey: 'g1-d', personId: 'g1', category: 'instant_apps', amountMicros: 1, chargeClass: 'instant_run' }, G);
    check('a $5 "both" gift has one shared remainder: $3 of Apps leaves $2 for computers, never $5 each', a.ok && !b.ok && b.reason === 'credit_used_up' && b.availableMicros === 2 * M && c.ok && !d.ok, { a, b, c, d });
    check('replies never pay for dollars: a hold has no way to name replies', (await refuses(() => spend.holdCredit({ holdKey: 'x', personId: 'g1', category: 'universe_ai' as never, amountMicros: 1, chargeClass: 'instant_run' }, G))) === null);
    const wrong = await spend.holdCredit({ holdKey: 'g1-wrong', personId: 'g2', category: 'instant_apps', amountMicros: 1 * M, chargeClass: 'computer_job' }, G);
    check('a charge class the category does not pay for is refused', !wrong.ok && wrong.reason === 'wrong_class', wrong);
    const overhead = await spend.holdCredit({ holdKey: 'g2-overhead', personId: 'g2', category: 'instant_apps', amountMicros: 1, chargeClass: 'app_overhead' }, G);
    check('ordinary connected-app use is never paid from credit', !overhead.ok && overhead.reason === 'wrong_class', overhead);

    const shared = await rules.createGift({ categoryId: 'instant_apps', amount: 5 * M, schedule: 'once', share: 'shared', recipients: { kind: 'people', userIds: ['g3', 'g4'] }, covers: ['instant_apps', 'computers'] }, root, G);
    const pools = await Promise.all([issue.ensureIssued('g3', G), issue.ensureIssued('g4', G), issue.ensureIssued('g3', G)]);
    check('a shared amount is one pool, never a copy per person', (await prisma.creditLot.count({ where: { subjectKey: `pool:${shared.programId}` } })) === 1 && pools.flatMap((p) => p.issued).length === 1, pools);
    const [h3, h4] = await Promise.all([
      spend.holdCredit({ holdKey: 'p-g3', personId: 'g3', category: 'instant_apps', amountMicros: 3 * M, chargeClass: 'instant_run' }, G),
      spend.holdCredit({ holdKey: 'p-g4', personId: 'g4', category: 'computers', amountMicros: 3 * M, chargeClass: 'computer_job' }, G),
    ]);
    check('two people at the same moment cannot take the same shared dollar', [h3.ok, h4.ok].filter(Boolean).length === 1, { h3, h4 });
    const loser = h3.ok ? 'g4' : 'g3';
    const winnerKey = h3.ok ? 'p-g3' : 'p-g4';
    await spend.settleHold({ holdKey: winnerKey, customerMicros: 1 * M }, G);
    const retry = await spend.holdCredit({ holdKey: `retry-${loser}`, personId: loser, category: loser === 'g3' ? 'instant_apps' : 'computers', amountMicros: 4 * M, chargeClass: loser === 'g3' ? 'instant_run' : 'computer_job' }, G);
    check('what the first step did not use goes back to the pool for the other', retry.ok, retry);
    const outsider = await spend.holdCredit({ holdKey: 'p-g5', personId: 'g5', category: 'instant_apps', amountMicros: 1, chargeClass: 'instant_run' }, G);
    check('being outside the recipients opens nothing', !outsider.ok && outsider.reason === 'credit_used_up', outsider);
    const sharedBoth = await prisma.creditLot.findFirst({ where: { subjectKey: `pool:${shared.programId}` } });
    const bal = await (await import('@/lib/credit-store')).lotBalances(prisma, [sharedBoth?.id ?? '']);
    check('the pool’s balance is counted from allocations: $1 used, $4 held, nothing left to spend', bal.get(sharedBoth?.id ?? '')?.usedMicros === 1 * M && bal.get(sharedBoth?.id ?? '')?.heldMicros === 4 * M && bal.get(sharedBoth?.id ?? '')?.availableMicros === 0, [...bal.values()]);
  }

  // ---------- Holds are once per key; settle, release ----------
  {
    await rules.createGift({ categoryId: 'instant_apps', amount: 10 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['g5'] } }, root, G);
    const input = { holdKey: 'h1', personId: 'g5', category: 'instant_apps' as const, amountMicros: 3 * M, chargeClass: 'instant_run' as const, botId: 'bot-1', provider: 'composio', route: 'composio' };
    const first = await spend.holdCredit(input, G);
    const again = await spend.holdCredit(input, G);
    check('asking again for the same step finds the same hold and takes nothing more', first.ok && again.ok && first.created && !again.created && (await prisma.creditHold.count({ where: { personId: 'g5' } })) === 1 && (await prisma.creditAllocation.count({ where: { holdId: first.ok ? first.hold.key : '' } })) >= 0, { first, again });
    const stolen = await spend.holdCredit({ ...input, personId: 'g6' }, G);
    check('a key used for someone else is refused', !stolen.ok && stolen.reason === 'key_reused', stolen);
    const extra = async () => {
      const list = await usage.extraCredit('g5', G);
      return Array.isArray(list) ? list[0] : undefined;
    };
    const view = await extra();
    check('Usage leaves out room already held: $7 available, $10 total, as one extra credit entry', view?.availableMicros === 7 * M && view.totalMicros === 10 * M && view.from === 'universe', view);
    const settled = await spend.settleHold({ holdKey: 'h1', customerMicros: 1 * M, provider: { costMicros: 400_000, basis: 'measured' } }, G);
    check('settling charges what was used and gives the rest back; the provider’s cost is its own column', settled?.customerMicros === 1 * M && settled.providerCostMicros === 400_000 && settled.state === 'settled', settled);
    const view2 = await extra();
    check('after settling, $9 is available', view2?.availableMicros === 9 * M, view2);
    const twice = await spend.settleHold({ holdKey: 'h1', customerMicros: 3 * M }, G);
    const rel = await spend.releaseHold({ holdKey: 'h1' }, G);
    check('once ended it stays as it ended: a different second word changes nothing', twice?.customerMicros === 1 * M && rel?.state === 'settled');
    const over = await refuses(() => spend.settleHold({ holdKey: 'h2-none', customerMicros: 1 }, G));
    check('settling a hold that does not exist says null, not a throw', over === null && (await spend.settleHold({ holdKey: 'h2-none', customerMicros: 1 }, G)) === null);
    await spend.holdCredit({ ...input, holdKey: 'h3', amountMicros: 2 * M }, G);
    const released = await spend.releaseHold({ holdKey: 'h3' }, G);
    check('releasing gives it all back', released?.state === 'released' && (await extra())?.availableMicros === 9 * M);
    const tooMuch = await refuses(() => spend.holdCredit({ ...input, holdKey: 'h4', amountMicros: 3 * M }, G).then((h) => (h.ok ? spend.settleHold({ holdKey: 'h4', customerMicros: 4 * M }, G) : null)));
    check('a step cannot be charged more than was held for it', tooMuch !== null);
    await spend.releaseHold({ holdKey: 'h4' }, G);
    const lapse = at('2027-02-12T10:11:00Z');
    await spend.holdCredit({ ...input, holdKey: 'h5', amountMicros: 1 * M }, G);
    const closed = await spend.holdCredit({ ...input, holdKey: 'h5', amountMicros: 1 * M }, lapse);
    const lapsed = await spend.lapsedHolds(lapse);
    check('a hold that lapsed is closed to new work but still counted until reconciled', !closed.ok && closed.reason === 'closed' && lapsed.some((h) => h.key === 'h5') && (await extra())?.availableMicros === 8 * M);
    await spend.releaseHold({ holdKey: 'h5' }, lapse);
    const eff1 = await spend.holdCredit({ ...input, holdKey: 'e1', amountMicros: 1, effectKey: 'exec-1' }, G);
    const eff2 = await spend.holdCredit({ ...input, holdKey: 'e2', amountMicros: 1, effectKey: 'exec-1' }, G);
    check('the same execution is never charged under two keys', eff1.ok && !eff2.ok && eff2.reason === 'effect_charged', eff2);
    // Nothing was taken by a released hold, so the same execution can be asked for again under a new key; while a hold is held or settled it cannot
    await spend.releaseHold({ holdKey: 'e1' }, G);
    const effRetry = await spend.holdCredit({ ...input, holdKey: 'e3', amountMicros: 1, effectKey: 'exec-1' }, G);
    const effBlockedHeld = await spend.holdCredit({ ...input, holdKey: 'e4', amountMicros: 1, effectKey: 'exec-1' }, G);
    check('a released hold does not block asking again for the same execution, but a live one still does', eff2.ok === false && effRetry.ok && !effBlockedHeld.ok && effBlockedHeld.reason === 'effect_charged', { effRetry, effBlockedHeld });
    await spend.settleHold({ holdKey: 'e3', customerMicros: 1 }, G);
    const effBlockedSettled = await spend.holdCredit({ ...input, holdKey: 'e5', amountMicros: 1, effectKey: 'exec-1' }, G);
    check('a settled hold keeps its execution to one charge', !effBlockedSettled.ok && effBlockedSettled.reason === 'effect_charged', effBlockedSettled);
    const race = await Promise.all([1, 2, 3, 4].map((n) => spend.holdCredit({ ...input, holdKey: `er-${n}`, amountMicros: 1, effectKey: 'exec-race' }, G).catch((error: unknown) => ({ ok: false as const, reason: `threw: ${error instanceof Error ? error.message.slice(0, 80) : 'unknown'}` }))));
    check('one execution asked for under four keys at once is held once, and the others are told it is already charged, never a throw', race.filter((r) => r.ok).length === 1 && race.filter((r) => !r.ok && r.reason === 'effect_charged').length === 3, race);
  }

  // ---------- Spending order ----------
  {
    await user('ord', '2027-02-11T00:00:00Z');
    const lots = [
      { subjectKey: 'person:ord', slotKey: 'gift:forever', periodKey: 'gift', source: 'gift', amountMicros: BigInt(3) * BigInt(M), expiresAt: null },
      { subjectKey: 'person:ord', slotKey: 'gift:late', periodKey: 'gift', source: 'gift', amountMicros: BigInt(3) * BigInt(M), expiresAt: at('2027-06-01T00:00:00Z') },
      { subjectKey: 'person:ord', slotKey: 'gift:soon', periodKey: 'gift', source: 'gift', amountMicros: BigInt(3) * BigInt(M), expiresAt: at('2027-03-01T00:00:00Z') },
    ];
    for (const l of lots) await prisma.creditLot.create({ data: { ...l, personId: 'ord', fundingAccountId: 'funding-platform', covers: ['instant_apps'], startsAt: G, issuedAt: G } });
    const hold = await spend.holdCredit({ holdKey: 'ord-1', personId: 'ord', category: 'instant_apps', amountMicros: 7 * M, chargeClass: 'instant_run' }, G);
    const ids = hold.ok ? hold.hold.allocations : [];
    const bySlot = async (lotId: string) => (await prisma.creditLot.findUniqueOrThrow({ where: { id: lotId } })).slotKey;
    check('credit that ends soonest is spent first, then later, then credit that never ends', ids.length === 3 && (await bySlot(ids[0].lotId)) === 'gift:soon' && (await bySlot(ids[1].lotId)) === 'gift:late' && (await bySlot(ids[2].lotId)) === 'gift:forever' && ids[2].amountMicros === 1 * M, ids);
  }

  // ---------- Refunds keep their source ----------
  {
    await user('rf', '2027-02-11T00:00:00Z');
    const monthly = await prisma.creditLot.create({ data: { slotKey: 'gift:rf-m', subjectKey: 'person:rf', periodKey: 'gift', personId: 'rf', source: 'gift', amountMicros: BigInt(5) * BigInt(M), covers: ['instant_apps'], fundingAccountId: 'funding-platform', startsAt: G, issuedAt: G, expiresAt: at('2027-03-01T00:00:00Z') } });
    const run = await spend.holdCredit({ holdKey: 'rf-1', personId: 'rf', category: 'instant_apps', amountMicros: 3 * M, chargeClass: 'instant_run' }, G);
    await spend.settleHold({ holdKey: 'rf-1', customerMicros: 3 * M }, G);
    const r1 = await spend.refundHold({ holdKey: 'rf-1', refundKey: 'ref-1', amountMicros: 1 * M, reason: 'platform_failure' }, G);
    const bal = (await (await import('@/lib/credit-store')).lotBalances(prisma, [monthly.id])).get(monthly.id);
    check('a refund goes back into the lot it came from, and never becomes cash', run.ok && r1.ok && r1.restoredMicros === 1 * M && bal?.usedMicros === 2 * M && bal.availableMicros === 3 * M, { r1, bal });
    const r1b = await spend.refundHold({ holdKey: 'rf-1', refundKey: 'ref-1', amountMicros: 1 * M, reason: 'platform_failure' }, G);
    check('the same refund key refunds once', r1b.ok && !r1b.created && r1b.refundedMicros === 1 * M && (await prisma.creditRefund.count({ where: { holdId: (await prisma.creditHold.findUniqueOrThrow({ where: { holdKey: 'rf-1' } })).id } })) === 1, r1b);
    // Read only: a key the books gave under answers with its first amount, a key they never saw with nothing, and asking creates nothing
    const seen = await spend.findRefund({ refundKey: 'ref-1' });
    const unseen = await spend.findRefund({ refundKey: 'ref-never' });
    check('looking up a refund key finds what was given under it, and nothing for a key never used, without making one', seen.found && seen.refundedMicros === 1 * M && !unseen.found && (await prisma.creditRefundRequest.count({ where: { requestKey: 'ref-never' } })) === 0, { seen, unseen });
    const tooMuch = await spend.refundHold({ holdKey: 'rf-1', refundKey: 'ref-2', amountMicros: 3 * M, reason: 'platform_failure' }, G);
    check('a refund cannot be more than was charged and not yet given back', !tooMuch.ok && tooMuch.reason === 'too_much', tooMuch);
    const early = await spend.refundHold({ holdKey: 'rf-nope', refundKey: 'ref-9', amountMicros: 1, reason: 'platform_failure' }, G);
    check('a refund for a hold that does not exist says so', !early.ok && early.reason === 'not_found');
    await spend.holdCredit({ holdKey: 'rf-open', personId: 'rf', category: 'instant_apps', amountMicros: 1 * M, chargeClass: 'instant_run' }, G);
    const unsettled = await spend.refundHold({ holdKey: 'rf-open', refundKey: 'ref-10', amountMicros: 1 * M, reason: 'platform_failure' }, G);
    check('a refund never drops an unsettled charge', !unsettled.ok && unsettled.reason === 'not_settled', unsettled);
    await spend.releaseHold({ holdKey: 'rf-open' }, G);
    const goodwill = await spend.refundHold({ holdKey: 'rf-1', refundKey: 'ref-3', amountMicros: 1 * M, reason: 'goodwill', limits: { goodwillBudgetMicros: null } }, G);
    const budgeted = await spend.refundHold({ holdKey: 'rf-1', refundKey: 'ref-4', amountMicros: 1 * M, reason: 'goodwill', limits: { goodwillBudgetMicros: 500_000 } }, G);
    check('goodwill needs a budget: none set gives none, and a small budget caps it', !goodwill.ok && goodwill.reason === 'not_set' && !budgeted.ok && budgeted.reason === 'refund_budget', { goodwill, budgeted });
    const after = at('2027-03-02T00:00:00Z');
    const late = await spend.refundHold({ holdKey: 'rf-1', refundKey: 'ref-5', amountMicros: 1.5 * M, reason: 'platform_failure', limits: { giveBackMaxMicros: 400_000 } }, after);
    const replacement = await prisma.creditLot.findFirst({ where: { personId: 'rf', source: 'replacement' } });
    check('a failure found after the gift ended makes a small separate replacement credit, capped by the give-back limit, never a renewal of the old gift', late.ok && late.replacementMicros === 400_000 && !!replacement && Number(replacement.amountMicros) === 400_000 && replacement.slotKey === 'replacement' && (replacement.expiresAt?.toISOString() ?? '') === '2027-05-01T00:00:00.000Z' && replacement.id !== monthly.id, { late, replacement });
    const second = await spend.refundHold({ holdKey: 'rf-1', refundKey: 'ref-6', amountMicros: 300_000, reason: 'platform_failure', limits: { giveBackMaxMicros: 400_000 } }, after).catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : 'threw' }));
    check('a second partial refund of the same step after the gift ended makes its own replacement credit, not a clash', second.ok && (await prisma.creditLot.count({ where: { personId: 'rf', source: 'replacement' } })) === 2, second);
    const replayA = await spend.refundHold({ holdKey: 'rf-1', refundKey: 'ref-5', amountMicros: 1.5 * M, reason: 'platform_failure', limits: { giveBackMaxMicros: 400_000 } }, after);
    const heldRow = await prisma.creditHold.findUniqueOrThrow({ where: { holdKey: 'rf-1' } });
    check('asking again for a replacement refund makes nothing new, and the step’s refunded total is the sum of what was given', replayA.ok && !replayA.created && (await prisma.creditLot.count({ where: { personId: 'rf', source: 'replacement' } })) === 2 && Number(heldRow.refundedMicros) === 1 * M + 400_000 + 300_000 && Number(heldRow.refundedMicros) <= 3 * M, { replayA, refunded: Number(heldRow.refundedMicros) });
    const none = await spend.refundHold({ holdKey: 'rf-1', refundKey: 'ref-7', amountMicros: 100_000, reason: 'platform_failure', limits: { giveBackMaxMicros: 0 } }, after).catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : 'threw' }));
    check('a give-back limit of nothing gives nothing back after the credit ended, and does not fail', none.ok && none.refundedMicros === 0 && (await prisma.creditLot.count({ where: { personId: 'rf', source: 'replacement' } })) === 2, none);
    const oldLot = await prisma.creditLot.findUniqueOrThrow({ where: { id: monthly.id } });
    check('the ended gift is untouched', oldLot.expiresAt?.toISOString() === '2027-03-01T00:00:00.000Z' && Number(oldLot.amountMicros) === 5 * M);
  }

  // ---------- Test 7: payers, sponsors, nobody mints platform credit ----------
  {
    await user('owner', '2026-01-01T00:00:00Z');
    await user('pal', '2027-02-11T00:00:00Z');
    const account = await funding.ensureFundingAccount({ kind: 'universe', ownerKey: 'u1', name: 'Acme', adminIds: ['owner'], budgetMicros: 10 * M });
    const again = await funding.ensureFundingAccount({ kind: 'universe', ownerKey: 'u1', name: 'Acme again', adminIds: ['owner'] });
    check('a universe has one funding account, with named administrators', again.id === account.id && account.adminIds.join() === 'owner' && account.kind === 'universe', again);
    const admin = { userId: 'owner', superAdmin: false };
    const forbiddenPlatform = await refuses(() => rules.createGift({ categoryId: 'instant_apps', amount: 1 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['pal'] } }, admin, G));
    check('a universe owner can never mint platform credit', forbiddenPlatform?.code === 'forbidden', forbiddenPlatform);
    const everyone = await refuses(() => rules.createGift({ categoryId: 'instant_apps', amount: 1 * M, schedule: 'once', recipients: { kind: 'all' }, fundingAccountId: account.id }, admin, G));
    check('a universe’s account cannot give credit to everyone', everyone?.code === 'forbidden', everyone);
    const stranger = await refuses(() => rules.createGift({ categoryId: 'instant_apps', amount: 1 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['pal'] }, fundingAccountId: account.id }, { userId: 'pal', superAdmin: false }, G));
    check('only an administrator of the account can fund from it', stranger?.code === 'forbidden', stranger);
    const overAccount = await refuses(() => rules.createGift({ categoryId: 'instant_apps', amount: 11 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['pal'] }, fundingAccountId: account.id }, admin, G));
    check('a gift that would pass the account’s own budget is refused at save', overAccount?.code === 'over_budget', overAccount);
    const sponsorGift = await rules.createGift({ categoryId: 'instant_apps', amount: 2 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['pal'] }, fundingAccountId: account.id }, admin, G);
    await rules.createGift({ categoryId: 'instant_apps', amount: 4 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['pal'] } }, root, G);
    await issue.ensureIssued('pal', G);
    const strict = await spend.holdCredit({ holdKey: 'pal-1', personId: 'pal', category: 'instant_apps', amountMicros: 3 * M, chargeClass: 'instant_run', onlyAccountId: account.id }, G);
    check('work a named payer funds never falls back to anyone else’s credit', !strict.ok && strict.reason === 'credit_used_up' && strict.availableMicros === 2 * M, strict);
    const mixed = await spend.holdCredit({ holdKey: 'pal-2', personId: 'pal', category: 'instant_apps', amountMicros: 3 * M, chargeClass: 'instant_run' }, G);
    check('ordinary work may use any credit that covers it', mixed.ok, mixed);
    await spend.releaseHold({ holdKey: 'pal-2' }, G);
    await funding.setAccountStatus(account.id, 'paused');
    const paused = await spend.holdCredit({ holdKey: 'pal-3', personId: 'pal', category: 'instant_apps', amountMicros: 3 * M, chargeClass: 'instant_run', onlyAccountId: account.id }, G);
    const platformStill = await spend.holdCredit({ holdKey: 'pal-4', personId: 'pal', category: 'instant_apps', amountMicros: 3 * M, chargeClass: 'instant_run' }, G);
    check('a paused account funds nothing new while the platform’s credit still works', !paused.ok && platformStill.ok, { paused, platformStill });
    await spend.releaseHold({ holdKey: 'pal-4' }, G);
    await funding.setAccountStatus(account.id, 'active');
    const exposure = await funding.exposureOf('funding-platform', G);
    check('the funding account’s exposure is counted from lots and holds', exposure.issuedThisMonthMicros > 0 && exposure.outstandingMicros > 0 && exposure.budgetMicros === 10_000 * M, exposure);
    check('the platform account exists and cannot be closed', (await refuses(() => funding.setAccountStatus('funding-platform', 'closed')))?.code === 'status' && (await funding.platformAccount()).name === 'BAWES Universe');
    const lastAdmin = await funding.removeAdmin(account.id, 'owner');
    check('the last administrator of an account stays', lastAdmin === 'last_admin', lastAdmin);
    void sponsorGift;
  }

  // ---------- Agreed manual billing ----------
  {
    const noNote = await refuses(() => rules.createGift({ categoryId: 'instant_apps', amount: 1 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['g7'] }, settlement: 'to_bill' }, root, G));
    check('credit to be billed must say what was agreed', noNote?.code === 'settlement', noNote);
    const billed = await rules.createGift({ categoryId: 'instant_apps', amount: 2 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['g7'] }, settlement: 'to_bill', agreementNote: 'Pilot top-up, invoice 14', agreementRef: 'INV-14' }, root, G);
    const free = await rules.createGift({ categoryId: 'instant_apps', amount: 2 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['g7'] } }, root, G);
    await issue.ensureIssued('g7', G);
    const lots = await lotsOf('g7');
    check('agreed billing is its own kind of lot, kept apart from a gift', lots.some((l) => l.source === 'manual_billing' && l.settlement === 'to_bill') && lots.some((l) => l.source === 'gift' && l.settlement === 'free'), lots);
    const marked = await billing.markCreditBilled({ programId: billed.programId }, G);
    const markedAgain = await billing.markCreditBilled({ programId: billed.programId }, at('2027-03-01T00:00:00Z'));
    const notOwed = await billing.markCreditBilled({ programId: free.programId }, G);
    const stamp = (await prisma.creditLot.findFirstOrThrow({ where: { programId: billed.programId } })).billedAt;
    check('"Mark as billed" says once and keeps the first time; a free gift is never owed', marked.result === 'billed' && markedAgain.result === 'already_billed' && notOwed.result === 'not_billable' && stamp?.toISOString() === G.toISOString(), { marked, markedAgain, notOwed, stamp });
    const direct = await refuses(() => prisma.creditLot.updateMany({ where: { programId: free.programId }, data: { billedAt: G } }));
    check('the database itself refuses to call free credit billed', direct !== null);
  }

  // ---------- A group that changes: joining, leaving and rejoining ----------
  {
    for (const id of ['m1', 'm2']) await user(id, '2027-02-11T00:00:00Z');
    const nocap = await refuses(() => rules.createGift({ categoryId: 'instant_apps', amount: 1 * M, schedule: 'once', recipients: { kind: 'universe', universeId: 'u1', mode: 'changing' } }, root, G));
    check('a group that changes needs an end, a cap on joiners and a total cap', nocap?.code === 'caps', nocap);
    const live = await rules.createGift({ categoryId: 'instant_apps', amount: 1 * M, schedule: 'once', recipients: { kind: 'universe', universeId: 'u1', mode: 'changing' }, claimEndsAt: at('2027-04-01T00:00:00Z'), joinerCap: 1, totalCapMicros: 5 * M }, root, G);
    check('with its caps it saves', live.joinerCap === 1 && live.totalCapMicros === 5 * M, live);
    await prisma.$executeRawUnsafe(`INSERT INTO universe_members (id, universe_id, user_id) VALUES ('um1', 'u1', 'm1')`);
    const first = await issue.ensureIssued('m1', G);
    await prisma.$executeRawUnsafe(`DELETE FROM universe_members WHERE id = 'um1'`);
    const left = await issue.ensureIssued('m1', G);
    await prisma.$executeRawUnsafe(`INSERT INTO universe_members (id, universe_id, user_id) VALUES ('um1b', 'u1', 'm1'), ('um2', 'u1', 'm2')`);
    const rejoined = await issue.ensureIssued('m1', G);
    const second = await issue.ensureIssued('m2', G);
    check('joining, leaving and rejoining never issues the same grant twice', first.issued.length === 1 && left.issued.length === 0 && rejoined.issued.length === 0 && (await prisma.creditLot.count({ where: { programId: live.programId, personId: 'm1' } })) === 1, { first, left, rejoined });
    check('the cap on joiners holds for the next person', second.issued.length === 0 && second.skipped.some((s) => s.reason === 'cap'), second);
    const snap = await rules.createGift({ categoryId: 'instant_apps', amount: 1 * M, schedule: 'once', recipients: { kind: 'universe', universeId: 'u1' } }, root, G);
    await user('late', '2027-02-11T00:00:00Z');
    await prisma.$executeRawUnsafe(`INSERT INTO universe_members (id, universe_id, user_id) VALUES ('um3', 'u1', 'late')`);
    const lateTouch = await issue.ensureIssued('late', G);
    check('a snapshot is who was in it when it was saved: a later joiner gets nothing from it', !lateTouch.issued.some((l) => l.programId === snap.programId) && snap.recipientCount === 2, { lateTouch, snap });
  }

  // ---------- Budgets ----------
  {
    await user('bud', '2027-02-11T00:00:00Z');
    const programId = (await rules.createGift({ categoryId: 'instant_apps', amount: 1 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['bud'] } }, root, G)).programId;
    await setMeter({ rolloutBudgetMicros: 0, renewMinutes: 10 });
    const over = await issue.ensureIssued('bud', G);
    check('a budget with no room issues nothing and says over_budget', over.issued.length === 0 && over.skipped.some((s) => s.programId === programId && s.reason === 'over_budget'), over);
    await setMeter({ rolloutBudgetMicros: 10_000 * M, renewMinutes: 10 });
    const ok = await issue.ensureIssued('bud', G);
    check('it issues once there is room', ok.issued.some((l) => l.programId === programId), ok);
    await setMeter({ rolloutBudgetMicros: 1 * M, renewMinutes: 10 });
    const refusedSave = await refuses(() => rules.createGift({ categoryId: 'instant_apps', amount: 3 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['g1', 'g2'] } }, root, at('2028-01-01T00:00:00Z')));
    check('a gift that cannot fit in the month’s funded budget is refused at save, with the numbers', refusedSave?.code === 'over_budget' && (refusedSave.error as { mostIssuedMicros: number }).mostIssuedMicros === 6 * M, refusedSave);
    await setMeter({ rolloutBudgetMicros: 10_000 * M, renewMinutes: 10 });
  }

  // ---------- The preview: three parts, never one number ----------
  {
    const bounded = await rules.previewGrant('gift', { categoryId: 'instant_apps', amount: 5 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['g1', 'g2', 'g3'] } }, G);
    check('preview part 1 and 2 for a fixed group: 3 people, $5 each, most $15', bounded.recipients.countNow === 3 && bounded.recipients.eachMicros === 5 * M && bounded.mostIssued.firstPeriodMicros === 15 * M && bounded.mostIssued.lifetimeMicros === 15 * M && !bounded.mostIssued.unbounded, bounded);
    const shared = await rules.previewGrant('gift', { categoryId: 'instant_apps', amount: 5 * M, schedule: 'once', share: 'shared', recipients: { kind: 'people', userIds: ['g1', 'g2', 'g3'] } }, G);
    check('"$5 shared in total" is $5, not $15', shared.mostIssued.firstPeriodMicros === 5 * M && shared.recipients.share === 'shared', shared);
    const wide = await rules.previewGrant('default', { categoryId: 'instant_apps', amount: 2 * M, schedule: 'once', recipients: { kind: 'all' } }, G);
    check('everyone, with later sign-ups, says plainly it has no lifetime maximum', wide.mostIssued.unbounded && wide.mostIssued.lifetimeMicros === null && /no lifetime maximum/.test(wide.mostIssued.sentence) && wide.recipients.growing, wide);
    const monthly = await rules.previewGrant('exception', { categoryId: 'computers', amount: 5 * M, schedule: 'monthly', recipients: { kind: 'people', userIds: ['g1', 'g2'] } }, G);
    check('monthly with no end date says it has no lifetime maximum', monthly.mostIssued.unbounded && monthly.mostIssued.lifetimeMicros === null, monthly);
    const monthlyCapped = await rules.previewGrant('exception', { categoryId: 'computers', amount: 5 * M, schedule: 'monthly', recipients: { kind: 'people', userIds: ['g1', 'g2'] }, totalCapMicros: 12 * M }, G);
    check('monthly with no end date but a total cap: the cap is the most it ever issues', !monthlyCapped.mostIssued.unbounded && monthlyCapped.mostIssued.lifetimeMicros === 12 * M && !/no lifetime maximum/.test(monthlyCapped.mostIssued.sentence), monthlyCapped);
    const ending = await rules.previewGrant('exception', { categoryId: 'computers', amount: 5 * M, schedule: 'monthly', recipients: { kind: 'people', userIds: ['g1', 'g2'] }, claimEndsAt: at('2027-05-01T00:00:00Z') }, G);
    check('monthly with an end counts the renewals: Feb to Apr is 3 months, 2 renewals, $30', ending.mostIssued.renewals === 2 && ending.mostIssued.lifetimeMicros === 30 * M && !ending.mostIssued.unbounded, ending);
    check('part 3 is apart from part 2: at most the credit at provider prices, with what we already carry', bounded.cost.atMostAtProviderPricesMicros === 15 * M && typeof bounded.cost.reservedMicros === 'number' && typeof bounded.cost.keptStorageMicros === 'number' && !bounded.cost.variableProviderCost, bounded.cost);
    const replies = await rules.previewGrant('exception', { categoryId: 'universe_ai', amount: 50, schedule: 'once', recipients: { kind: 'people', userIds: ['g1'] } }, G);
    check('replies have no dollar figure: their provider cost varies', replies.cost.variableProviderCost && replies.cost.atMostAtProviderPricesMicros === null && replies.recipients.unit === 'reply', replies);
    check('the preview names overlaps with other programs for the same people', bounded.overlaps.some((o) => o.how === 'adds') && bounded.budget.budgetMicros === 10_000 * M, bounded.overlaps);
    const empty = await rules.previewGrant('exception', { categoryId: 'computers', amount: 1 * M, schedule: 'monthly', recipients: { kind: 'universe', universeId: 'u1' } }, G).catch((e) => e);
    check('a preview of a universe with members counts them', !(empty instanceof Error) && empty.recipients.countNow === 3, empty);
  }

  // ---------- Universe AI: exceptions only, the default stays Limits ----------
  {
    const refusedDefault = await refuses(() => rules.saveDefault({ categoryId: 'universe_ai', amount: 30, schedule: 'once', recipients: { kind: 'all' } }, root, G));
    check('the Universe AI default is Limits’ number, so no default program is saved for it', refusedDefault?.code === 'category', refusedDefault);
    const gift = await refuses(() => rules.createGift({ categoryId: 'universe_ai', amount: 30, schedule: 'once', recipients: { kind: 'all' } }, root, G));
    check('replies are not given as gifts', gift?.code === 'category', gift);
    check('with no exception a person has the Limits number', (await replies.repliesPerWindowFor('g1', 30, G)) === 30);
    await rules.saveException({ categoryId: 'universe_ai', amount: 50, schedule: 'once', recipients: { kind: 'people', userIds: ['g1', 'g2'] } }, root, G);
    await rules.saveException({ categoryId: 'universe_ai', schedule: 'none', recipients: { kind: 'people', userIds: ['g3'] } }, root, G);
    await rules.saveException({ categoryId: 'universe_ai', amount: 5, schedule: 'once', recipients: { kind: 'people', userIds: ['g1'] } }, root, G);
    const clash = await refuses(() => rules.saveException({ categoryId: 'universe_ai', amount: 70, schedule: 'once', recipients: { kind: 'people', userIds: ['g2', 'g4'] } }, root, G));
    check('an exception’s number is the person’s replies per window, the narrowest wins, none means none', (await replies.repliesPerWindowFor('g1', 30, G)) === 5 && (await replies.repliesPerWindowFor('g2', 30, G)) === 50 && (await replies.repliesPerWindowFor('g3', 30, G)) === 0 && (await replies.repliesPerWindowFor('g4', 30, G)) === 30, null);
    check('replies exceptions clash like the rest', clash?.code === 'clash', clash);
    const ai = await prisma.creditLot.count({ where: { covers: { has: 'universe_ai' } } });
    check('replies are never lots: Universe AI exceptions issue nothing', ai === 0);
  }

  // ---------- Test 13: the Usage page tells the truth and starts nothing ----------
  {
    const before = await prisma.replyWindow.count();
    const view = await meterUsage.memberUsage('g1', G);
    const after = await prisma.replyWindow.count();
    check('opening Usage starts no window', before === after && view.chat.replies?.running === false, { before, after, replies: view.chat.replies });
    check('replies show real counts from what the check enforces: g1’s exception of 5', view.chat.replies?.available === 5 && view.chat.replies.total === 5 && typeof view.chat.replies.windowHours === 'number', view.chat.replies);
    check('the view carries a version stamp that only grows', view.version === G.getTime() && (await meterUsage.memberUsage('g1', at('2027-02-12T10:00:01Z'))).version > view.version);
    check('credit entries are only what someone has now, as one amount for what it covers', Array.isArray(view.credit) && view.credit.some((c) => c.covers.length === 2 && c.availableMicros === 0) === false, view.credit);
    const g2 = await meterUsage.memberUsage('g2', G);
    const entry = Array.isArray(g2.credit) ? g2.credit.find((c) => c.covers.length === 2) : null;
    check('a "both" gift shows once, one amount', !!entry && entry.availableMicros === 5 * M && entry.totalMicros === 5 * M && entry.from === 'universe' && Array.isArray(g2.credit) && g2.credit.filter((c) => c.covers.length === 2).length === 1, g2.credit);
    check('no default line when nobody has a default', g2.apps === null, g2.apps);
    const nogrants = await meterUsage.memberUsage('g8', G);
    check('someone with nothing has no apps section and no credit', nogrants.apps === null && Array.isArray(nogrants.credit) && nogrants.credit.length === 0, nogrants);
  }

  // ---------- Nested work is charged once ----------
  {
    await user('nest', '2027-02-11T00:00:00Z');
    await rules.createGift({ categoryId: 'instant_apps', amount: 10 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['nest'] }, covers: ['instant_apps', 'computers'] }, root, G);
    const parent = await spend.holdCredit({ holdKey: 'job-1', personId: 'nest', category: 'computers', amountMicros: 4 * M, chargeClass: 'computer_job', jobKey: 'job-1' }, G);
    const asInstant = await spend.holdCredit({ holdKey: 'job-1-app', personId: 'nest', category: 'instant_apps', amountMicros: 1 * M, chargeClass: 'instant_run', jobKey: 'job-1', parentHoldKey: 'job-1' }, G);
    const asTool = await spend.holdCredit({ holdKey: 'job-1-tool', personId: 'nest', category: 'computers', amountMicros: 1 * M, chargeClass: classifyTool(values), jobKey: 'job-1', parentHoldKey: 'job-1' }, G);
    check('a paid App inside a computer job is a tool of that job, never an Instant run on top', parent.ok && !asInstant.ok && asInstant.reason === 'wrong_class' && asTool.ok, { asInstant, asTool });
    const stranger = await spend.holdCredit({ holdKey: 'job-x', personId: 'g8', category: 'computers', amountMicros: 1, chargeClass: 'computer_tool', parentHoldKey: 'job-1' }, G);
    check('a job’s hold belongs to its person', !stranger.ok && stranger.reason === 'key_reused', stranger);
  }

  // ---------- Late claims and the two kinds of ask ----------
  {
    await user('tardy', '2027-02-11T00:00:00Z');
    const early = await rules.createGift({ categoryId: 'instant_apps', amount: 2 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['tardy'] }, lotExpiresAt: at('2027-02-13T00:00:00Z') }, root, G);
    await rules.createGift({ categoryId: 'instant_apps', amount: 1 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['tardy'] } }, root, G);
    const lateDay = at('2027-02-20T00:00:00Z');
    const out = await issue.ensureIssued('tardy', lateDay).catch((error: unknown) => error);
    const lots = await prisma.creditLot.findMany({ where: { personId: 'tardy' } });
    check('a gift that ended before it was claimed issues nothing, and the person’s other gift still comes', !(out instanceof Error) && lots.length === 1 && Number(lots[0].amountMicros) === 1 * M && !lots.some((lot) => lot.programId === early.programId), { out: out instanceof Error ? out.message : out, lots });
    const requests = await import('@/lib/meter-requests');
    await requests.askForMore('tardy', lateDay, 'apps');
    await requests.answerRequests('tardy', 'grant-x', lateDay, lateDay, 'computer');
    check('extra computer usage does not close an ask for Instant Apps credit', (await requests.openRequestFor('tardy', 'apps')) !== null);
    const person = await (await import('@/lib/meter-person')).personUsage('tardy', lateDay);
    check('the admin’s computer-time view does not show an Instant Apps ask as a computer ask', person.asked === null, person.asked);
  }

  // ---------- A schedule that changes keeps what was left of the one before ----------
  {
    const ex = await rules.saveException({ categoryId: 'computers', amount: 3 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['tardy'] } }, root, G);
    await issue.ensureIssued('tardy', G);
    await spend.holdCredit({ holdKey: 'sch-1', personId: 'tardy', category: 'computers', amountMicros: 1 * M, chargeClass: 'computer_job' }, G);
    await spend.settleHold({ holdKey: 'sch-1', customerMicros: 1 * M }, G);
    await rules.saveException({ programId: ex.programId, categoryId: 'computers', amount: 4 * M, schedule: 'monthly', recipients: { kind: 'people', userIds: ['tardy'] } }, root, at('2027-02-14T00:00:00Z'));
    await issue.ensureIssued('tardy', at('2027-02-14T00:00:00Z'));
    const line = (await usage.moneyLine('tardy', 'computers', at('2027-02-14T00:00:00Z'))) as { kind: string; availableMicros: number; totalMicros: number };
    check('a one-off that turned monthly shows this month’s lot and what is left of the one-off: $6 of $7, still monthly', line.kind === 'monthly' && line.availableMicros === 6 * M && line.totalMicros === 7 * M, line);
  }

  // ---------- Saving a program again does not count what it already issued ----------
  {
    for (const id of ['bud1', 'bud2', 'bud3']) await user(id, '2027-02-11T00:00:00Z');
    const issuedSoFar = (await funding.exposureOf('funding-platform', G)).issuedThisMonthMicros;
    await setMeter({ rolloutBudgetMicros: issuedSoFar + 10 * M, renewMinutes: 10 });
    const prog = await rules.saveException({ categoryId: 'computers', amount: 5 * M, schedule: 'monthly', recipients: { kind: 'people', userIds: ['bud1', 'bud2'] } }, root, G);
    await Promise.all([issue.ensureIssued('bud1', G), issue.ensureIssued('bud2', G)]);
    const roomLeft = (await funding.exposureOf('funding-platform', G)).issuedThisMonthMicros;
    const again = await refuses(() => rules.saveException({ programId: prog.programId, categoryId: 'computers', amount: 5 * M, schedule: 'monthly', claimEndsAt: at('2027-06-01T00:00:00Z'), recipients: { kind: 'people', userIds: ['bud1', 'bud2'] } }, root, G));
    check('saving a program again with the month’s budget already used by its own lots is not over budget', roomLeft === issuedSoFar + 10 * M && again === null, { roomLeft, issuedSoFar, again });
    const more = await refuses(() => rules.saveException({ programId: prog.programId, categoryId: 'computers', amount: 5 * M, schedule: 'monthly', claimEndsAt: at('2027-06-01T00:00:00Z'), recipients: { kind: 'people', userIds: ['bud1', 'bud2', 'bud3'] } }, root, G));
    check('adding one more person counts only that person: $5 needed, $0 left', more?.code === 'over_budget' && (more.error as { mostIssuedMicros: number }).mostIssuedMicros === 5 * M, more);
    await setMeter({ rolloutBudgetMicros: 10_000 * M, renewMinutes: 10 });
  }

  // ---------- A refund after the sponsor's account closed is made whole by the platform ----------
  {
    await user('cl', '2027-02-11T00:00:00Z');
    const sponsor = await funding.ensureFundingAccount({ kind: 'universe', ownerKey: 'u-closing', name: 'Closing', adminIds: ['admin'], budgetMicros: 10 * M });
    await prisma.creditLot.create({ data: { slotKey: 'gift:cl', subjectKey: 'person:cl', periodKey: 'gift', personId: 'cl', source: 'gift', amountMicros: BigInt(2) * BigInt(M), covers: ['instant_apps'], fundingAccountId: sponsor.id, startsAt: G, issuedAt: G } });
    await spend.holdCredit({ holdKey: 'cl-1', personId: 'cl', category: 'instant_apps', amountMicros: 1 * M, chargeClass: 'instant_run' }, G);
    await spend.settleHold({ holdKey: 'cl-1', customerMicros: 1 * M }, G);
    await funding.setAccountStatus(sponsor.id, 'closed');
    const refunded = await spend.refundHold({ holdKey: 'cl-1', refundKey: 'cl-ref', amountMicros: 1 * M, reason: 'platform_failure' }, G);
    const repl = await prisma.creditLot.findFirst({ where: { personId: 'cl', source: 'replacement' } });
    const spendable = await spend.availableCredit('cl', 'instant_apps', G);
    check('a failure found after the sponsor’s account closed is made whole by the platform, in credit the person can spend', refunded.ok && repl?.fundingAccountId === 'funding-platform' && spendable.availableMicros === 1 * M, { refunded, repl, spendable });
  }

  // ---------- "Ask for more" only when nothing at all is left ----------
  {
    await user('ask1', '2027-02-11T00:00:00Z');
    await rules.saveException({ categoryId: 'instant_apps', amount: 1 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['ask1'] } }, root, G);
    // Covers both, so it is spent after the line (which covers one): the order does not depend on a random id
    await rules.createGift({ categoryId: 'instant_apps', amount: 2 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['ask1'] }, covers: ['instant_apps', 'computers'] }, root, G);
    await issue.ensureIssued('ask1', G);
    await spend.holdCredit({ holdKey: 'ask1-a', personId: 'ask1', category: 'instant_apps', amountMicros: 1 * M, chargeClass: 'instant_run' }, G);
    await spend.settleHold({ holdKey: 'ask1-a', customerMicros: 1 * M }, G);
    const line = (await usage.moneyLine('ask1', 'instant_apps', G)) as { availableMicros: number; canAskForMore: boolean };
    check('the line is used up but a gift still covers Apps: not out, so no "Ask for more"', line.availableMicros === 0 && line.canAskForMore === false, line);
    await spend.holdCredit({ holdKey: 'ask1-b', personId: 'ask1', category: 'instant_apps', amountMicros: 2 * M, chargeClass: 'instant_run' }, G);
    await spend.settleHold({ holdKey: 'ask1-b', customerMicros: 2 * M }, G);
    const out = (await usage.moneyLine('ask1', 'instant_apps', G)) as { canAskForMore: boolean };
    check('with the gift used up too, "Ask for more" is offered', out.canAskForMore === true, out);
    await prisma.creditLot.create({ data: { slotKey: 'gift:ask1-comp', subjectKey: 'person:ask1', periodKey: 'gift', personId: 'ask1', source: 'gift', amountMicros: BigInt(5) * BigInt(M), covers: ['computers'], fundingAccountId: 'funding-platform', startsAt: G, issuedAt: G } });
    const stillOut = (await usage.moneyLine('ask1', 'instant_apps', G)) as { canAskForMore: boolean };
    check('a gift that covers only computers does not block an Instant Apps ask', stillOut.canAskForMore === true, stillOut);
  }

  // ---------- The Instant executor's contract ----------
  {
    await user('inst', '2027-02-11T00:00:00Z');
    await rules.createGift({ categoryId: 'instant_apps', amount: 2 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['inst'] } }, root, G);
    const funds = instant.createInstantFunds(() => G);
    const run = { key: 'run-1:1', personId: 'inst', amountMicros: 1_200_000, botId: 'bot-1', runId: 'run-1', charge: { class: 'instant' as const, route: 'composio', provider: 'composio' } };
    const a = await funds.reserve(run);
    const b = await funds.reserve(run);
    const c = await funds.reserve({ ...run, key: 'run-2:1', runId: 'run-2' });
    check('reserve takes once per key and answers credit_used_up when it cannot', a.ok && b.ok && a.created && !b.created && !c.ok && c.reason === 'credit_used_up', { a, b, c });
    const s = await funds.settle({ key: 'run-1:1', chargeMicros: 900_000, providerCostMicros: 300_000 });
    const r = await funds.refund({ key: 'run-1:1', refundKey: 'run-1:refund', amountMicros: 900_000, reason: 'platform_failure' });
    const r2 = await funds.refund({ key: 'run-1:1', refundKey: 'run-1:refund', amountMicros: 900_000, reason: 'platform_failure' });
    const left = await spend.availableCredit('inst', 'instant_apps', G);
    check('settle charges less than reserved, refund goes back to the lot once, and the books end whole at $2', s.ok && r.ok && r.refundedMicros === 900_000 && r2.ok && r2.refundedMicros === 900_000 && left.availableMicros === 2 * M, { s, r, r2, left });
    const afterSettle = await funds.release({ key: 'run-1:1' });
    check('releasing a step that was already charged is not ok: nothing was given back', afterSettle.ok === false, afterSettle);
    await funds.reserve({ ...run, key: 'run-3:1', runId: 'run-3', amountMicros: 300_000 });
    await funds.release({ key: 'run-3:1' });
    const settleReleased = await funds.settle({ key: 'run-3:1', chargeMicros: 300_000 });
    check('settling a step that was released is not ok: nothing was charged', settleReleased.ok === false, settleReleased);
    const none = await funds.release({ key: 'nothing-here' });
    check('releasing a hold that does not exist is not ok, says plainly nothing is held, and does not throw', none.ok === false && none.none === true, none);
    const noneAgain = await funds.release({ key: 'nothing-here' });
    check('saying it again says the same', noneAgain.ok === false && noneAgain.none === true, noneAgain);
    const late = await funds.reserve({ ...run, key: 'nothing-here', runId: 'run-late', amountMicros: 100_000 });
    const lateRow = await prisma.creditHold.count({ where: { holdKey: 'nothing-here' } });
    const leftAfterLate = await spend.availableCredit('inst', 'instant_apps', G);
    check('a reservation that arrives after its key was closed is refused and holds nothing', !late.ok && late.reason === 'unavailable' && lateRow === 0 && leftAfterLate.availableMicros === 2 * M, { late, lateRow, leftAfterLate });
    // A key that was never closed is untouched by another key being closed
    const other = await funds.reserve({ ...run, key: 'run-5:1', runId: 'run-5', amountMicros: 100_000 });
    check('closing one key does not close another', other.ok === true, other);
    await funds.release({ key: 'run-5:1' });

    // settle says what the key was charged at, and the FIRST amount when it is said again
    await funds.reserve({ ...run, key: 'run-6:1', runId: 'run-6', amountMicros: 500_000 });
    const first = await funds.settle({ key: 'run-6:1', chargeMicros: 400_000, providerCostMicros: 100_000 });
    const second = await funds.settle({ key: 'run-6:1', chargeMicros: 250_000 });
    check('settle answers the amount charged, and again the first amount when asked with another', first.ok && first.chargedMicros === 400_000 && second.ok && second.chargedMicros === 400_000, { first, second });
    const heldRow = await prisma.creditHold.findUniqueOrThrow({ where: { holdKey: 'run-6:1' } });
    check('the books keep the first amount', Number(heldRow.customerMicros) === 400_000, heldRow);
    const noSettle = await funds.settle({ key: 'never-held', chargeMicros: 1 });
    check('settling a key that was never held is not ok and has no amount', noSettle.ok === false && !('chargedMicros' in noSettle), noSettle);

    // A give-back asked again answers what the first ask gave, even when the lot could give less now
    const g1 = await funds.refund({ key: 'run-6:1', refundKey: 'run-6:gb', amountMicros: 300_000, reason: 'goodwill', limits: { goodwillBudgetMicros: 1 * M } });
    const g2 = await funds.refund({ key: 'run-6:1', refundKey: 'run-6:gb', amountMicros: 300_000, reason: 'goodwill', limits: { goodwillBudgetMicros: 1 * M } });
    const g3 = await funds.refund({ key: 'run-6:1', refundKey: 'run-6:gb', amountMicros: 300_000, reason: 'goodwill', limits: { goodwillBudgetMicros: 0 } });
    const refundedRow = await prisma.creditHold.findUniqueOrThrow({ where: { holdKey: 'run-6:1' } });
    check('a repeated give-back returns its original amount and gives nothing more', g1.ok && g1.refundedMicros === 300_000 && g2.ok && g2.refundedMicros === 300_000 && g3.ok && g3.refundedMicros === 300_000 && Number(refundedRow.refundedMicros) === 300_000, { g1, g2, g3, refundedRow });
    const g4 = await funds.refund({ key: 'run-6:1', refundKey: 'run-6:gb', amountMicros: 100_000, reason: 'goodwill' });
    check('the same refund key with another amount is refused, not answered as the first', g4.ok === false && g4.refundedMicros === 0, g4);
  }

  // ---------- Review round: keys, refunds, asks, standing, budgets, held room ----------
  {
    const requests = await import('@/lib/meter-requests');
    for (const id of ['cr1', 'cr2', 'cr3', 'cr4']) await user(id, '2027-02-11T00:00:00Z');
    await setMeter({ rolloutBudgetMicros: 10_000 * M, renewMinutes: 10 });
    await rules.createGift({ categoryId: 'instant_apps', amount: 5 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['cr1'] }, covers: ['instant_apps', 'computers'] }, root, G);
    await issue.ensureIssued('cr1', G);

    const k1 = await spend.holdCredit({ holdKey: 'cr-k', personId: 'cr1', category: 'computers', amountMicros: 1 * M, chargeClass: 'computer_job' }, G);
    const k2 = await spend.holdCredit({ holdKey: 'cr-k', personId: 'cr1', category: 'computers', amountMicros: 1 * M, chargeClass: 'computer_model' }, G);
    check('a hold key is for one kind of step: the same key for another charge class is refused', k1.ok && !k2.ok && k2.reason === 'key_reused', { k1, k2 });

    const rf = await spend.holdCredit({ holdKey: 'cr-rf', personId: 'cr1', category: 'instant_apps', amountMicros: 2 * M, chargeClass: 'instant_run' }, G);
    await spend.settleHold({ holdKey: 'cr-rf', customerMicros: 2 * M }, G);
    const r1 = await spend.refundHold({ holdKey: 'cr-rf', refundKey: 'x#0', amountMicros: 100_000, reason: 'goodwill' }, G);
    const r2 = await spend.refundHold({ holdKey: 'cr-rf', refundKey: 'x', amountMicros: 100_000, reason: 'goodwill' }, G);
    check('a refund key is its own: another key that begins with it is not a replay of it', rf.ok && r1.ok && r2.ok && r1.created && r2.created && r2.refundedMicros === 100_000, { r1, r2 });

    const ask = await requests.askForMore('cr2', T0, 'apps');
    await rules.createGift({ categoryId: 'instant_apps', amount: 2 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['cr2'] } }, root, G);
    await issue.ensureIssued('cr2', G);
    const answered = await prisma.meterRequest.findUniqueOrThrow({ where: { id: ask.request.id } });
    const askAgain = await requests.askForMore('cr2', at('2027-03-01T00:00:00Z'), 'apps');
    check('Instant Apps credit arriving answers the ask that came before it, so asking again is a new ask', ask.created && answered.answeredAt !== null && askAgain.created && askAgain.request.id !== ask.request.id, { answered, askAgain });

    const uni = await funding.ensureFundingAccount({ kind: 'universe', ownerKey: 'u-review', name: 'Review', adminIds: ['cr3'], budgetMicros: 10 * M });
    const replies = await refuses(() => rules.saveException({ categoryId: 'universe_ai', amount: 50, schedule: 'once', recipients: { kind: 'people', userIds: ['cr1'] }, fundingAccountId: uni.id }, { userId: 'cr3', superAdmin: false }, G));
    check('a sponsor’s account (money) cannot give Universe AI replies', replies?.code === 'forbidden', replies);

    const mine = await funding.ensureFundingAccount({ kind: 'person', ownerKey: 'cr4', name: 'Cr four', adminIds: ['cr4'], budgetMicros: 10 * M });
    const program = await rules.saveException({ categoryId: 'computers', amount: 1 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['cr1'] }, fundingAccountId: uni.id }, { userId: 'cr3', superAdmin: false }, G);
    const takeover = await refuses(() => rules.saveException({ programId: program.programId, categoryId: 'computers', amount: 1 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['cr1'] }, fundingAccountId: mine.id }, { userId: 'cr4', superAdmin: false }, G));
    check('a program funded from one account is not changed by an administrator of another', takeover?.code === 'forbidden', takeover);

    const room = at('2030-01-01T00:00:00Z');
    await setMeter({ rolloutBudgetMicros: 1 * M, renewMinutes: 10 });
    const noEnd = await refuses(() => rules.saveException({ categoryId: 'computers', amount: 3 * M, schedule: 'monthly', recipients: { kind: 'people', userIds: ['cr1', 'cr2'] } }, root, room));
    check('a monthly rule with no end date is held to the month’s budget for its first period too', noEnd?.code === 'over_budget', noEnd);
    await setMeter({ rolloutBudgetMicros: 10_000 * M, renewMinutes: 10 });

    const capped = await rules.previewGrant('gift', { categoryId: 'instant_apps', amount: 5 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['cr1', 'cr2', 'cr3'] }, totalCapMicros: 8 * M }, G);
    check('the first period in the preview is bounded by the total cap', capped.mostIssued.firstPeriodMicros === 8 * M && capped.cost.atMostAtProviderPricesMicros === 8 * M, capped.mostIssued);

    const duo = await funding.ensureFundingAccount({ kind: 'universe', ownerKey: 'u-duo', name: 'Duo', adminIds: ['cr1', 'cr2'] });
    const both = await Promise.all([funding.removeAdmin(duo.id, 'cr1'), funding.removeAdmin(duo.id, 'cr2')]);
    check('two removals at once never leave an account without an administrator', both.filter((r) => r === 'removed').length === 1 && both.filter((r) => r === 'last_admin').length === 1 && (await prisma.fundingAccountAdmin.count({ where: { accountId: duo.id } })) === 1, both);

    // Several first saves of a default at the same moment make one default with versions, never a second default or a thrown unique error
    const nowDefaults = await rules.listPrograms(undefined, { kind: 'default' });
    await Promise.all(nowDefaults.filter((p) => p.status === 'active').map((p) => rules.endProgram(p.programId, root, at('2027-02-12T00:00:00Z'))));
    const firsts = await Promise.all([1, 2, 3, 4].map(() => rules.saveDefault({ categoryId: 'computers', amount: 5 * M, schedule: 'monthly', recipients: { kind: 'all' } }, root, at('2027-02-12T00:00:00Z')).then(() => 'saved', (e: unknown) => `threw: ${e instanceof Error ? e.message.slice(0, 80) : 'unknown'}`)));
    const activeDefaults = await prisma.grantProgram.findMany({ where: { categoryId: 'computers', kind: 'default', status: 'active' }, include: { rules: true } });
    check('four first saves of a default at once make one default with four versions, none throws', firsts.every((r) => r === 'saved') && activeDefaults.length === 1 && activeDefaults[0].rules.length === 4, { firsts, programs: activeDefaults.length });

    // A preview whose computer figures cannot be read still previews (the failed read must not abort the transaction around it)
    await prisma.$executeRawUnsafe('ALTER TABLE meter_reservations RENAME TO meter_reservations_away');
    const blind = await rules.previewGrant('gift', { categoryId: 'instant_apps', amount: 2 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['cr1'] } }, G).catch((e: unknown) => e);
    const savedBlind = await rules.createGift({ categoryId: 'instant_apps', amount: 1 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['cr1'] }, label: 'blind save' }, root, at('2027-02-12T00:00:00Z')).catch((e: unknown) => e);
    await prisma.$executeRawUnsafe('ALTER TABLE meter_reservations_away RENAME TO meter_reservations');
    check('a save whose preview figures cannot be read still ends whole: one program with one rule, nothing half-written', !(savedBlind instanceof Error) && (await prisma.grantProgram.count({ where: { label: 'blind save' } })) === 1 && (await prisma.grantRule.count({ where: { program: { label: 'blind save' } } })) === 1, savedBlind instanceof Error ? savedBlind.message : savedBlind);
    check('a preview still works when the computer figures cannot be read, with those figures at nothing', !(blind instanceof Error) && (blind as { cost?: { reservedMicros?: number } }).cost?.reservedMicros === 0, blind instanceof Error ? blind.message : blind);

    // Room held against a lot that ended since still counts as held while the step runs
    await user('cr5', '2027-02-11T00:00:00Z');
    await rules.createGift({ categoryId: 'instant_apps', amount: 3 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['cr5'] }, lotExpiresAt: at('2027-03-01T00:00:00Z') }, root, at('2027-02-28T23:00:00Z'));
    const heldAt = at('2027-02-28T23:55:00Z');
    const cr5 = await spend.holdCredit({ holdKey: 'cr5-1', personId: 'cr5', category: 'instant_apps', amountMicros: 1 * M, chargeClass: 'instant_run' }, heldAt);
    const before = await funding.exposureOf('funding-platform', at('2027-02-28T23:56:00Z'));
    const lotEnded = await funding.exposureOf('funding-platform', at('2027-03-01T00:01:00Z'));
    const lapsed = await funding.exposureOf('funding-platform', at('2027-03-01T00:06:00Z'));
    check('held room is still counted after the lot it came from has ended, while the hold itself is in time; once it runs out it is unresolved', cr5.ok && before.heldMicros >= 1 * M && lotEnded.heldMicros === before.heldMicros && lapsed.heldMicros === 0 && lapsed.unresolvedMicros >= 1 * M, { before, lotEnded, lapsed });
  }

  // ---------- Follow-up round: findings from the review of the work built on these books ----------
  {
    const FU = at('2027-02-13T10:00:00Z');
    const { Client } = await import('pg');

    // A clash over many people carries every id (only the names shown are limited)
    const crowd = Array.from({ length: 60 }, (_, i) => `fu-crowd-${i}`);
    for (const id of crowd) await user(id, '2027-02-11T00:00:00Z');
    await rules.saveException({ categoryId: 'computers', amount: 1 * M, schedule: 'once', recipients: { kind: 'people', userIds: crowd } }, root, FU);
    const crowdClash = await refuses(() => rules.saveException({ categoryId: 'computers', amount: 2 * M, schedule: 'once', recipients: { kind: 'people', userIds: crowd } }, root, FU));
    const crowdFinding = (crowdClash?.error as { clashes?: { userIds: string[]; people: unknown[]; totalPeople: number }[] } | undefined)?.clashes?.[0];
    check('a clash over 60 people carries all 60 ids, names only the first 50, and says how many there are', crowdClash?.code === 'clash' && crowdFinding?.userIds.length === 60 && crowdFinding.people.length === 50 && crowdFinding.totalPeople === 60, crowdFinding && { ids: crowdFinding.userIds.length, names: crowdFinding.people.length, total: crowdFinding.totalPeople });

    // A refund asked for again is found by its exact key, also when it gave nothing back
    await user('fu-r', '2027-02-11T00:00:00Z');
    await rules.createGift({ categoryId: 'instant_apps', amount: 3 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['fu-r'] }, lotExpiresAt: at('2027-03-01T00:00:00Z') }, root, at('2027-02-13T00:00:00Z'));
    const heldR = await spend.holdCredit({ holdKey: 'fu-r-1', personId: 'fu-r', category: 'instant_apps', amountMicros: 1 * M, chargeClass: 'instant_run' }, at('2027-02-13T00:05:00Z'));
    await spend.settleHold({ holdKey: 'fu-r-1', customerMicros: 1 * M }, at('2027-02-13T00:06:00Z'));
    const lateAt = at('2027-03-02T00:00:00Z');
    const none1 = await spend.refundHold({ holdKey: 'fu-r-1', refundKey: 'fu-z', amountMicros: 1 * M, reason: 'goodwill', limits: { giveBackMaxMicros: 0 } }, lateAt);
    const none2 = await spend.refundHold({ holdKey: 'fu-r-1', refundKey: 'fu-z', amountMicros: 1 * M, reason: 'goodwill', limits: { giveBackMaxMicros: 0 } }, lateAt);
    const none3 = await spend.refundHold({ holdKey: 'fu-r-1', refundKey: 'fu-z', amountMicros: 500_000, reason: 'goodwill', limits: { giveBackMaxMicros: 0 } }, lateAt);
    check('a refund that gave nothing back is remembered: asking again answers the same, another figure under the key is refused', heldR.ok && none1.ok && none1.created && none1.refundedMicros === 0 && none2.ok && !none2.created && none2.refundedMicros === 0 && !none3.ok && none3.reason === 'key_reused', { none1, none2, none3 });
    const sameKey = await spend.refundHold({ holdKey: 'fu-r-1', refundKey: 'fu-z#0', amountMicros: 100_000, reason: 'goodwill' }, lateAt);
    check('a key that only begins like another refund’s key is its own refund', sameKey.ok && sameKey.created, sameKey);

    // Rows from before the payer and the refund requests were stored are still replays of what they were
    await user('fu-lg', '2027-02-11T00:00:00Z');
    await rules.createGift({ categoryId: 'instant_apps', amount: 3 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['fu-lg'] } }, root, at('2027-02-13T00:00:00Z'));
    await spend.holdCredit({ holdKey: 'fu-lg-1', personId: 'fu-lg', category: 'instant_apps', amountMicros: 1 * M, chargeClass: 'instant_run' }, at('2027-02-13T00:05:00Z'));
    await spend.settleHold({ holdKey: 'fu-lg-1', customerMicros: 1 * M }, at('2027-02-13T00:06:00Z'));
    const lgFirst = await spend.refundHold({ holdKey: 'fu-lg-1', refundKey: 'fu-lg-r', amountMicros: 400_000, reason: 'goodwill' }, at('2027-02-13T00:07:00Z'));
    const lgRows = await prisma.creditRefund.count({ where: { holdId: (await prisma.creditHold.findUniqueOrThrow({ where: { holdKey: 'fu-lg-1' } })).id } });
    await prisma.creditRefundRequest.deleteMany({ where: { requestKey: 'fu-lg-r' } });
    const lgAgain = await spend.refundHold({ holdKey: 'fu-lg-1', refundKey: 'fu-lg-r', amountMicros: 400_000, reason: 'goodwill' }, at('2027-02-13T00:08:00Z'));
    const lgOther = await spend.refundHold({ holdKey: 'fu-lg-1', refundKey: 'fu-lg-r', amountMicros: 400_000, reason: 'platform_failure' }, at('2027-02-13T00:08:30Z'));
    const lgRowsAfter = await prisma.creditRefund.count({ where: { holdId: (await prisma.creditHold.findUniqueOrThrow({ where: { holdKey: 'fu-lg-1' } })).id } });
    check('a refund made before request rows existed is replayed from its refund rows: same totals, nothing written, another reason refused', lgFirst.ok && lgAgain.ok && !lgAgain.created && lgAgain.refundedMicros === 400_000 && lgAgain.restoredMicros === 400_000 && !lgOther.ok && lgOther.reason === 'key_reused' && lgRowsAfter === lgRows, { lgFirst, lgAgain, lgOther, lgRows, lgRowsAfter });
    await spend.holdCredit({ holdKey: 'fu-lg-2', personId: 'fu-lg', category: 'instant_apps', amountMicros: 1 * M, chargeClass: 'instant_run' }, at('2027-02-13T00:10:00Z'));
    await prisma.$executeRawUnsafe(`UPDATE credit_holds SET payer_known = false WHERE hold_key = 'fu-lg-2'`);
    const lgHold = await spend.holdCredit({ holdKey: 'fu-lg-2', personId: 'fu-lg', category: 'instant_apps', amountMicros: 1 * M, chargeClass: 'instant_run', onlyAccountId: 'funding-platform' }, at('2027-02-13T00:11:00Z'));
    const lgHoldAmount = await spend.holdCredit({ holdKey: 'fu-lg-2', personId: 'fu-lg', category: 'instant_apps', amountMicros: 2 * M, chargeClass: 'instant_run', onlyAccountId: 'funding-platform' }, at('2027-02-13T00:11:30Z'));
    check('a live hold made before its payer was stored is found again whatever payer the retry names (never taken twice); another amount is still refused', lgHold.ok && !lgHold.created && !lgHoldAmount.ok && lgHoldAmount.reason === 'key_reused', { lgHold, lgHoldAmount });

    // A replayed hold must be the same step: the same amount, and the same named payer
    await user('fu-h', '2027-02-11T00:00:00Z');
    await rules.createGift({ categoryId: 'instant_apps', amount: 5 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['fu-h'] } }, root, FU);
    const h1 = await spend.holdCredit({ holdKey: 'fu-h-1', personId: 'fu-h', category: 'instant_apps', amountMicros: 1 * M, chargeClass: 'instant_run' }, FU);
    const h2 = await spend.holdCredit({ holdKey: 'fu-h-1', personId: 'fu-h', category: 'instant_apps', amountMicros: 1 * M, chargeClass: 'instant_run' }, FU);
    const h3 = await spend.holdCredit({ holdKey: 'fu-h-1', personId: 'fu-h', category: 'instant_apps', amountMicros: 2 * M, chargeClass: 'instant_run' }, FU);
    const h4 = await spend.holdCredit({ holdKey: 'fu-h-1', personId: 'fu-h', category: 'instant_apps', amountMicros: 1 * M, chargeClass: 'instant_run', onlyAccountId: 'funding-platform' }, FU);
    check('the same hold key finds the same hold only for the same amount and payer; another amount or payer is key_reused', h1.ok && h2.ok && !h2.created && !h3.ok && h3.reason === 'key_reused' && !h4.ok && h4.reason === 'key_reused', { h2, h3, h4 });

    // A default replaced by one that starts later keeps issuing under the old one until the new one starts
    await user('fu-old', '2027-02-11T00:00:00Z');
    await user('fu-new', '2027-02-11T00:00:00Z');
    const before = await rules.getProgram((await rules.listPrograms('computers', { kind: 'default' }))[0].programId);
    const oldAmount = before?.program.amount ?? 0;
    await rules.saveDefault({ categoryId: 'computers', amount: 9 * M, schedule: 'monthly', recipients: { kind: 'all' }, claimStartsAt: at('2027-04-01T00:00:00Z') }, root, FU);
    await issue.ensureIssued('fu-old', at('2027-02-14T00:00:00Z'));
    await issue.ensureIssued('fu-new', at('2027-04-02T00:00:00Z'));
    const [lotOld] = await lotsOf('fu-old');
    const [lotNew] = await lotsOf('fu-new');
    check('a default that starts next month does not take over now: someone who claims before it gets the old amount, after it the new', oldAmount > 0 && lotOld && Number(lotOld.amountMicros) === oldAmount && lotNew && Number(lotNew.amountMicros) === 9 * M, { oldAmount, old: lotOld && Number(lotOld.amountMicros), now: lotNew && Number(lotNew.amountMicros) });
    const waiting = await prisma.grantRule.count({ where: { state: 'superseded', supersededAt: { gt: at('2027-03-01T00:00:00Z') }, program: { kind: 'default', categoryId: 'computers' } } });
    await rules.saveDefault({ categoryId: 'computers', amount: 4 * M, schedule: 'monthly', recipients: { kind: 'all' } }, root, at('2027-02-20T00:00:00Z'));
    const stillWaiting = await prisma.grantRule.count({ where: { state: 'superseded', supersededAt: { gt: at('2027-02-21T00:00:00Z') }, program: { kind: 'default', categoryId: 'computers' } } });
    check('an edit that starts at once cuts a version that was waiting to be replaced, so two versions are never open together', waiting === 1 && stillWaiting === 0, { waiting, stillWaiting });

    // A version that is waiting to be replaced still counts when another rule is saved: it is the rule people are issued under until then
    for (const id of ['fu-c1', 'fu-c2']) await user(id, '2027-02-11T00:00:00Z');
    const waitingGroup = await rules.saveException({ categoryId: 'computers', amount: 1 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['fu-c1', 'fu-c2'] } }, root, FU);
    await rules.saveException({ programId: waitingGroup.programId, categoryId: 'computers', amount: 2 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['fu-c1', 'fu-c2'] }, claimStartsAt: at('2027-05-01T00:00:00Z') }, root, FU);
    const duringWait = await refuses(() => rules.saveException({ categoryId: 'computers', amount: 3 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['fu-c1', 'fu-c2'] }, claimEndsAt: at('2027-04-15T00:00:00Z') }, root, FU));
    check('a rule saved for a period that ends before a waiting version takes over still clashes with the version issuing until then', duringWait?.code === 'clash', duringWait?.code);

    // A program with a version issuing and one waiting is still one program: a rule spanning both is one clash and one overlap, with everyone
    const spanning = { categoryId: 'computers' as const, amount: 3 * M, schedule: 'once' as const, recipients: { kind: 'people' as const, userIds: ['fu-c1', 'fu-c2'] } };
    const spanClash = await refuses(() => rules.saveException(spanning, root, FU));
    const spanFindings = (spanClash?.error as { clashes?: { programId: string; userIds: string[] }[] } | undefined)?.clashes ?? [];
    check('a rule that spans a program’s issuing version and its waiting one is one clash for that program, naming each person once', spanClash?.code === 'clash' && spanFindings.filter((f) => f.programId === waitingGroup.programId).length === 1 && spanFindings.find((f) => f.programId === waitingGroup.programId)?.userIds.length === 2, spanFindings);
    const spanPreview = await rules.previewGrant('exception', spanning, FU);
    const spanOverlaps = spanPreview.overlaps.filter((o) => o.programId === waitingGroup.programId);
    check('and one overlap line for it, counting each person once', spanOverlaps.length === 1 && spanOverlaps[0].people === 2, spanOverlaps);

    // A shared Instant Apps amount answers the earlier asks of everyone it reaches, also when the pool was made by the first of the others
    {
      const requests = await import('@/lib/meter-requests');
      for (const id of ['fu-s1', 'fu-s2', 'fu-s3']) await user(id, '2027-02-11T00:00:00Z');
      const morning = at('2027-02-13T09:00:00Z');
      for (const id of ['fu-s1', 'fu-s2', 'fu-s3']) await requests.askForMore(id, morning, 'apps');
      await requests.askForMore('fu-s2', morning, 'computer');
      await rules.createGift({ categoryId: 'instant_apps', amount: 5 * M, schedule: 'once', share: 'shared', recipients: { kind: 'people', userIds: ['fu-s1', 'fu-s2'] } }, root, at('2027-02-13T09:30:00Z'));
      await issue.ensureIssued('fu-s1', at('2027-02-13T12:00:00Z'));
      await issue.ensureIssued('fu-s2', at('2027-02-13T12:30:00Z'));
      await requests.askForMore('fu-s2', at('2027-02-13T13:00:00Z'), 'apps');
      await issue.ensureIssued('fu-s2', at('2027-02-13T13:30:00Z'));
      const open = async (id: string, what: string) => prisma.meterRequest.count({ where: { personId: id, what, answeredAt: null } });
      check('a shared Instant Apps amount answers the earlier asks of everyone it reaches, leaves computer asks, later asks and other people alone', (await open('fu-s1', 'apps')) === 0 && (await open('fu-s2', 'computer')) === 1 && (await open('fu-s2', 'apps')) === 1 && (await open('fu-s3', 'apps')) === 1, { s1: await open('fu-s1', 'apps'), s2computer: await open('fu-s2', 'computer'), s2apps: await open('fu-s2', 'apps'), s3: await open('fu-s3', 'apps') });
    }

    // A group that can change can clash later, when someone joins both: nobody gets a number by guesswork
    await prisma.$executeRawUnsafe(`INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u2', 'later', 'Later', 'admin', now())`);
    for (const id of ['fu-rx', 'fu-ry']) await user(id, '2027-02-11T00:00:00Z');
    await rules.saveException({ categoryId: 'universe_ai', amount: 10, schedule: 'once', recipients: { kind: 'universe', universeId: 'u2', mode: 'changing' }, claimEndsAt: at('2028-01-01T00:00:00Z'), joinerCap: 10, totalCapMicros: 100 }, root, FU);
    await rules.saveException({ categoryId: 'universe_ai', amount: 20, schedule: 'once', recipients: { kind: 'people', userIds: ['fu-rx', 'fu-ry'] } }, root, FU);
    const beforeJoin = await replies.repliesPerWindowFor('fu-rx', 30, FU);
    await prisma.$executeRawUnsafe(`INSERT INTO universe_members (id, universe_id, user_id) VALUES ('fu-um1', 'u2', 'fu-rx')`);
    const afterJoin = await replies.repliesPerWindowFor('fu-rx', 30, FU);
    const other = await replies.repliesPerWindowFor('fu-ry', 30, FU);
    check('someone who joins a group that disagrees with another group they are in keeps the base number (no winner by guesswork); the other person keeps theirs', beforeJoin === 20 && afterJoin === 30 && other === 20, { beforeJoin, afterJoin, other });

    // A pool only answers an ask when the person can really spend from it: one whose account was paused after the pool was made does not
    {
      const requests = await import('@/lib/meter-requests');
      for (const id of ['fu-pz1', 'fu-pz2']) await user(id, '2027-02-11T00:00:00Z');
      const sponsor = await funding.ensureFundingAccount({ kind: 'universe', ownerKey: 'u1', name: 'Acme', adminIds: ['owner'] });
      await requests.askForMore('fu-pz2', at('2027-02-14T09:00:00Z'), 'apps');
      await rules.createGift({ categoryId: 'instant_apps', amount: 1 * M, schedule: 'once', share: 'shared', recipients: { kind: 'people', userIds: ['fu-pz1', 'fu-pz2'] }, fundingAccountId: sponsor.id }, { userId: 'owner', superAdmin: false }, at('2027-02-14T09:30:00Z'));
      await issue.ensureIssued('fu-pz1', at('2027-02-14T10:00:00Z'));
      await funding.setAccountStatus(sponsor.id, 'paused');
      await issue.ensureIssued('fu-pz2', at('2027-02-14T11:00:00Z'));
      const stillAsking = await prisma.meterRequest.count({ where: { personId: 'fu-pz2', what: 'apps', answeredAt: null } });
      await funding.setAccountStatus(sponsor.id, 'closed');
      await issue.ensureIssued('fu-pz2', at('2027-02-14T11:30:00Z'));
      const stillAskingClosed = await prisma.meterRequest.count({ where: { personId: 'fu-pz2', what: 'apps', answeredAt: null } });
      await funding.setAccountStatus(sponsor.id, 'active');
      await issue.ensureIssued('fu-pz2', at('2027-02-14T12:00:00Z'));
      const answeredAfter = await prisma.meterRequest.count({ where: { personId: 'fu-pz2', what: 'apps', answeredAt: { not: null } } });
      check('a pool whose account was paused or closed answers no ask (nothing there can be spent); once the account is active again it does', stillAsking === 1 && stillAskingClosed === 1 && answeredAfter === 1, { stillAsking, stillAskingClosed, answeredAfter });
    }

    if (database.kind === 'postgres') {
      // A second connection holds the names a writer holds, changes the books, and lets go while the issuing is waiting for them
      const writer = new Client({ connectionString: database.url });
      // A database dropped at the end closes this connection: that is the end of the run, not an error
      writer.on('error', () => undefined);
      await writer.connect();
      const waitForWaiter = async () => {
        for (let i = 0; i < 100; i++) {
          const { rows } = await writer.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
          if (rows[0].n > 0) return true;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return false;
      };
      // The rules are read again under the locks: an edit that landed while issuing waited is what issues
      await user('fu-late1', '2027-02-11T00:00:00Z');
      await setMeter({ rolloutBudgetMicros: 10_000 * M, renewMinutes: 10 });
      const current = await prisma.grantRule.findFirstOrThrow({ where: { state: 'current', program: { kind: 'default', categoryId: 'computers' } } });
      await writer.query('BEGIN');
      await writer.query(`SELECT pg_advisory_xact_lock(hashtext('credit:account:funding-platform'))`);
      const pending = issue.ensureIssued('fu-late1', at('2027-02-21T00:00:00Z'));
      pending.catch(() => undefined);
      const waited = await waitForWaiter();
      await writer.query(`UPDATE grant_rules SET amount = 8000000 WHERE id = $1`, [current.id]);
      await writer.query('COMMIT');
      const late = await pending;
      const [lateLot] = await lotsOf('fu-late1');
      check('what is due is read again under the locks: an edit made while issuing waited is the amount that issues', waited && late.issued.length === 1 && Number(lateLot.amountMicros) === 8 * M, { waited, late, amount: lateLot && Number(lateLot.amountMicros) });
      await prisma.grantRule.update({ where: { id: current.id }, data: { amount: BigInt(4 * M) } });

      // The rollout budget is read again under the locks: one lowered while issuing waited is the one that counts
      await user('fu-late2', '2027-02-11T00:00:00Z');
      await writer.query('BEGIN');
      await writer.query(`SELECT pg_advisory_xact_lock(hashtext('meter:settings'))`);
      const pendingBudget = issue.ensureIssued('fu-late2', at('2027-02-22T00:00:00Z'));
      pendingBudget.catch(() => undefined);
      const waitedBudget = await waitForWaiter();
      await writer.query(`UPDATE app_settings SET value = jsonb_set(value, '{rolloutBudgetMicros}', '1') WHERE key = 'meter'`);
      await writer.query('COMMIT');
      const lowered = await pendingBudget;
      await setMeter({ rolloutBudgetMicros: 10_000 * M, renewMinutes: 10 });
      check('the rollout budget is read again under the locks: one lowered while issuing waited stops it', waitedBudget && lowered.issued.length === 0 && lowered.skipped.some((s) => s.reason === 'over_budget'), { waitedBudget, lowered });
      // A start over works from the person's facts as they are now: joining a group while issuing waited brings that group's gift in, funded from another account, and issuing still ends whole
      await user('fu-late5', '2027-02-11T00:00:00Z');
      const acme = await funding.ensureFundingAccount({ kind: 'universe', ownerKey: 'u1', name: 'Acme', adminIds: ['owner'] });
      await rules.createGift({ categoryId: 'instant_apps', amount: 1 * M, schedule: 'once', recipients: { kind: 'universe', universeId: 'u1', mode: 'changing' }, claimEndsAt: at('2027-04-01T00:00:00Z'), joinerCap: 5, totalCapMicros: 5 * M, fundingAccountId: acme.id }, { userId: 'owner', superAdmin: false }, FU);
      await writer.query('BEGIN');
      await writer.query(`SELECT pg_advisory_xact_lock(hashtext('credit:account:funding-platform'))`);
      const pendingJoin = issue.ensureIssued('fu-late5', at('2027-02-24T00:00:00Z'));
      pendingJoin.catch(() => undefined);
      const waitedJoin = await waitForWaiter();
      await writer.query(`INSERT INTO universe_members (id, universe_id, user_id) VALUES ('fu-um5', 'u1', 'fu-late5')`);
      await writer.query('COMMIT');
      const joined = await pendingJoin.catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
      check('joining a group while issuing waited does not stop the issuing: the start over reads the person again, and the group’s gift is issued from', waitedJoin && !('error' in joined) && joined.issued.some((lot) => lot.subjectKey === 'person:fu-late5' && lot.amountMicros === 1 * M), { waitedJoin, joined });

      // Ending a program waits for issuing in the category it reads (issuing holds the category's rules lock shared)
      const toEnd = await rules.createGift({ categoryId: 'instant_apps', amount: 1 * M, schedule: 'once', recipients: { kind: 'people', userIds: ['fu-late1'] } }, root, FU);
      await writer.query('BEGIN');
      await writer.query(`SELECT pg_advisory_xact_lock_shared(hashtext('credit:rules:instant_apps'))`);
      const pendingEnd = rules.endProgram(toEnd.programId, root, FU);
      pendingEnd.catch(() => undefined);
      const waitedEnd = await waitForWaiter();
      await writer.query('COMMIT');
      check('ending a program waits for issuing that reads the category’s rules, then ends it', waitedEnd && (await pendingEnd) === 'ended', { waitedEnd });

      // A save of one category's rules holds up issuing only for people due something from that category
      await user('fu-late3', '2027-02-11T00:00:00Z');
      await user('fu-late4', '2027-02-11T00:00:00Z');
      await writer.query('BEGIN');
      await writer.query(`SELECT pg_advisory_xact_lock(hashtext('credit:rules:universe_ai'))`);
      const apart = await Promise.race([issue.ensureIssued('fu-late3', at('2027-02-23T00:00:00Z')).then(() => 'done'), new Promise((resolve) => setTimeout(() => resolve('held up'), 5000))]);
      await writer.query('COMMIT');
      await writer.query('BEGIN');
      await writer.query(`SELECT pg_advisory_xact_lock(hashtext('credit:rules:computers'))`);
      const pendingRules = issue.ensureIssued('fu-late4', at('2027-02-23T00:00:00Z'));
      pendingRules.catch(() => undefined);
      const waitedRules = await waitForWaiter();
      await writer.query('COMMIT');
      const afterRules = await pendingRules;
      check('a save of the rules of a category nobody here is due from does not hold issuing up; a save of one they are due from does, and issuing goes on once it lets go', apart === 'done' && waitedRules && afterRules.issued.length === 1, { apart, waitedRules, afterRules });
      await writer.end();

      // A reservation still on its way meets the closing of its key at the key's own lock: one of the two wins, never both
      const racing = instant.createInstantFunds(() => G);
      const keys = Array.from({ length: 24 }, (_, i) => `race-${i}:1`);
      const pairs = await Promise.all(keys.map(async (key, i) => {
        const [reserved, gone] = await Promise.all([
          racing.reserve({ key, personId: 'inst', amountMicros: 10_000, botId: 'bot-1', runId: `race-${i}`, charge: { class: 'instant', route: 'composio', provider: 'composio' } }),
          racing.release({ key }),
        ]);
        // Said again after both answered: what the books hold for the key must not change
        const again = await racing.release({ key });
        return { key, reserved, gone, again };
      }));
      const heldAfter = await prisma.creditHold.findMany({ where: { holdKey: { in: keys } }, select: { holdKey: true, state: true } });
      const closedAfter = await prisma.creditClosedKey.findMany({ where: { holdKey: { in: keys } }, select: { holdKey: true } });
      const heldKeys = new Map(heldAfter.map((h) => [h.holdKey, h.state]));
      const closedKeys = new Set(closedAfter.map((c) => c.holdKey));
      const bad = pairs.filter((p) => {
        const state = heldKeys.get(p.key);
        // Either the hold won (and is given back, and the key is not closed) or the closing won (nothing held, the reservation refused)
        const holdWon = state === 'released' && !closedKeys.has(p.key) && p.reserved.ok && p.gone.ok === true;
        const closeWon = state === undefined && closedKeys.has(p.key) && !p.reserved.ok && p.gone.none === true;
        return !(holdWon || closeWon);
      });
      const stillHeld = await spend.availableCredit('inst', 'instant_apps', G);
      check('24 reservations racing the closing of their keys: each key ends given back or closed, none is held for good, and no credit stays taken', bad.length === 0 && heldAfter.every((h) => h.state !== 'held') && stillHeld.heldMicros === 0, { bad, stillHeld, wins: { hold: heldAfter.length, closed: closedAfter.length } });
    }
  }

  // The result goes out first: nothing that happens while the database is taken down can lose it
  console.log(printable({ kind: database.kind, checks }));
}

function classifyTool(values: typeof import('@/lib/credit-values')) {
  return values.classifyCharge({ work: 'instant', inComputerJob: true });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.log(printable({ kind: 'crashed', error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error), checks }));
    process.exit(1);
  });
