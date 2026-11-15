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

async function main() {
  const database = await startTestDatabase();
  const { prisma, close } = await connect(database);
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
    check('releasing a hold that does not exist is not ok, not a throw', none.ok === false);
  }

  // The result goes out first: nothing that happens while the database is taken down can lose it
  console.log(JSON.stringify({ kind: database.kind, checks }));
  await close();
  await database.stop().catch(() => undefined);
  process.exit(0);
}

function classifyTool(values: typeof import('@/lib/credit-values')) {
  return values.classifyCharge({ work: 'instant', inComputerJob: true });
}

main().catch((error) => {
  console.log(JSON.stringify({ kind: 'crashed', error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error), checks }));
  process.exit(1);
});
