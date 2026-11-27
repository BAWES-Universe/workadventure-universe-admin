import { createHmac } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getBrickLimits } from '@/lib/bot-limits';
import { checkAppUse } from '@/lib/app-connections';
import { addNotice } from '@/lib/notices';
import { reportConnectionSignIn, reportKeyNoAnswer, reportKeyWorked } from '@/lib/tool-signin';
import { resolveExpectedLoginOrigin } from '@/lib/auth';
import { definitionSchema, hashDefinition, type Definition } from '@/lib/app-direct/definition';
import { guardedRequest, GuardError, serviceDidNotAnswer, type GuardDeps } from '@/lib/app-direct/guard';
import { buildRequest, pickFields, RequestError } from '@/lib/app-direct/request';
import { readKey } from '@/lib/app-direct/connect';

/**
 * Payments for pages (game #2044, step 3). A page the owner asked a Brick to make can ask for one fixed amount, through an app of theirs
 * whose definition has a payment contract. What holds on every path:
 *  - the amount and currency are the JOB's, frozen when the owner asked for it; the page and the visitor send neither;
 *  - the order is written on our side BEFORE the service is asked, and its id is the service's idempotency key and order reference, so a
 *    retry or a lost answer reconciles instead of making a second payment;
 *  - the buyer is only ever sent to a host the definition names for checkouts (never the host the key goes to);
 *  - "paid" is only written after the service's OWN record of the payment, read with the key, says completed for this order, this exact
 *    amount, this currency and this mode. A notice from the service, a return to the page or anything the page says only makes us look.
 */

const EXPONENTS: Record<string, number> = {
  KWD: 3, BHD: 3, OMR: 3, JOD: 3, TND: 3,
  JPY: 0, KRW: 0, VND: 0,
  USD: 2, EUR: 2, GBP: 2, AED: 2, SAR: 2, QAR: 2, EGP: 2, CAD: 2, AUD: 2, CHF: 2, INR: 2, TRY: 2, SGD: 2, HKD: 2, NZD: 2, SEK: 2, NOK: 2, DKK: 2, PLN: 2, MYR: 2,
};

/** The most a single order can be, in the currency's smallest units: well inside a 32-bit number. */
const LARGEST_MINOR = 2_000_000_000;

export const currencyExponent = (currency: unknown): number | null => (typeof currency === 'string' && Object.hasOwn(EXPONENTS, currency.toUpperCase()) ? EXPONENTS[currency.toUpperCase()] : null);

/**
 * An amount as whole minor units (4.500 KWD is 4500), exact: it is read as text, never as a float, and one with more decimals than
 * the currency has (other than zeros) is refused rather than rounded. Null when it is not a usable amount.
 */
export function amountToMinor(input: unknown, currency: string): number | null {
  const exponent = currencyExponent(currency);
  if (exponent === null) return null;
  const text = typeof input === 'number' ? (Number.isFinite(input) ? String(input) : '') : typeof input === 'string' ? input.trim() : '';
  const match = /^(\d{1,10})(?:\.(\d{1,12}))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? '';
  const extra = fraction.slice(exponent);
  if (/[^0]/.test(extra)) return null;
  const minor = Number(match[1]) * 10 ** exponent + (exponent === 0 ? 0 : Number(fraction.slice(0, exponent).padEnd(exponent, '0')));
  return Number.isSafeInteger(minor) && minor > 0 && minor <= LARGEST_MINOR ? minor : null;
}

/** The amount as it is written for people and sent to the service: 4500 minor KWD is "4.500". */
export function minorToText(minor: number, currency: string): string {
  const exponent = currencyExponent(currency) ?? 2;
  return exponent === 0 ? String(minor) : (minor / 10 ** exponent).toFixed(exponent);
}

const valueAt = (source: unknown, path: string): unknown => path.split('.').reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), source);

function definitionOf(connection: { definition: Prisma.JsonValue | null; definitionHash: string | null }): Definition | null {
  const parsed = definitionSchema.safeParse(connection.definition);
  return parsed.success && hashDefinition(parsed.data) === connection.definitionHash ? parsed.data : null;
}

/** Orbit's own address, where the service sends the buyer back and tells us a payment moved. */
function ownOrigin(): string | null {
  const origin = resolveExpectedLoginOrigin(process.env.NEXT_PUBLIC_API_URL || process.env.ADMIN_API_URL, '');
  return origin.startsWith('https://') || (process.env.NODE_ENV !== 'production' && origin) ? origin : null;
}

/** Who started a checkout, kept only as a hash with a secret: to count tries, never to know who. */
export function visitorHash(raw: string): string {
  return createHmac('sha256', process.env.ENCRYPTION_KEY ?? 'universe-visitor').update(`page-visitor:${raw}`).digest('hex');
}

/** What a host makes for a purchase wish: one per tap, plain characters only, so it can only be echoed and compared. */
export const INTENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** What a guest's own host keeps for them (never the page): long enough that nobody can guess it. */
export const RECOVERY_CODE = /^[A-Za-z0-9_-]{32,128}$/;

/** A signed-in buyer: their account. */
export const accountBuyerKey = (accountId: string): string => `acct:${accountId}`;

/**
 * A guest buyer: only a hash of the recovery code their host keeps is ever stored, so nothing we hold lets anyone but the holder of the
 * code get back to the purchase. Null for a code that is not one (too short to be unguessable, or not plain characters).
 */
export function guestBuyerKey(code: unknown): string | null {
  if (typeof code !== 'string' || !RECOVERY_CODE.test(code)) return null;
  return `guest:${createHmac('sha256', process.env.ENCRYPTION_KEY ?? 'universe-visitor').update(`page-buyer:${code}`).digest('hex')}`;
}

/**
 * Who a buyer is, for a purchase and for getting back to it. A signed-in account (a person the game names, or an Orbit session) is the
 * account; anyone else is their recovery code's hash. Null when there is neither (a start from an older host that sends no code): that
 * start is made as before, with nothing to find it by.
 */
export function buyerKeyOf(input: { accountId?: string | null; recoveryCode?: unknown }): string | null {
  return buyerKeysOf(input)[0] ?? null;
}

/**
 * Every key this buyer's purchases may be under, the account first. A guest who paid and then signed in has both: the account (new orders
 * are made under it) and the recovery code their browser still holds, which proves the guest orders are theirs. Looking under both is what
 * keeps a purchase from being lost to signing in, and a wish started as a guest from being made twice when it is retried signed in.
 */
export function buyerKeysOf(input: { accountId?: string | null; recoveryCode?: unknown }): string[] {
  const guest = guestBuyerKey(input.recoveryCode);
  return [...(input.accountId ? [accountBuyerKey(input.accountId)] : []), ...(guest ? [guest] : [])];
}

/**
 * The keys a buyer may ASK under (Restore purchase, Check payment): their own, and the one a receipt link they opened holds. A receipt link's
 * code only ever finds the purchases made under it; it is never a key to make a new one under, so it is never in the list a start uses.
 */
export function askKeysOf(ownKeys: string[], receiptCode: unknown): string[] {
  const receipt = guestBuyerKey(receiptCode);
  return receipt && !ownKeys.includes(receipt) ? [...ownKeys, receipt] : ownKeys;
}

// ---- The owner's side: a job per page --------------------------------------------------------------------------

/**
 * A job as it is saved, in one canonical form, so whoever asked for it can compare it with what the owner asked for without reading
 * text: `amountMinor` is a whole number of the currency's smallest units (4.500 KWD is 4500), `currency` is upper case, `exponent` is how
 * many decimals the currency has (0, 2 or 3), and `amount` is the same amount as text for people.
 */
export interface JobView {
  id: string;
  artifactId: string;
  /** The app the page pays through: its id, and its name for people. */
  connectionId: string;
  app: string;
  amount: string;
  amountMinor: number;
  currency: string;
  exponent: number;
  description: string | null;
  status: 'active' | 'stopped';
  active: boolean;
}

const jobView = (job: { id: string; artifactId: string; connectionId: string; amountMinor: number; currency: string; description: string | null; status: string }, app: string): JobView => ({
  id: job.id,
  artifactId: job.artifactId,
  connectionId: job.connectionId,
  app,
  amount: minorToText(job.amountMinor, job.currency),
  amountMinor: job.amountMinor,
  currency: job.currency,
  exponent: currencyExponent(job.currency) ?? 2,
  description: job.description,
  status: job.status === 'stopped' ? 'stopped' : 'active',
  active: job.status !== 'stopped',
});

export type CreateJobOutcome =
  /**
   * `waitsForPublish`: the page's link still shows an older published version, so nobody who opens it by its link can pay with these terms
   * until the owner publishes this version (or a later one). The owner is told so: checkouts on the older version are refused, never made with
   * terms its visitors were not shown.
   */
  | { status: 'ok'; job: JobView; replaced: boolean; waitsForPublish: boolean }
  | { status: 'refused'; reason: 'gone' | 'off' | 'not_owner' | 'incomplete' }
  | { status: 'not_found' }
  | { status: 'no_payments' }
  | { status: 'bad_terms'; message: string };

/**
 * What goes in the service's description field for the owner's words: only as the field allows (see `fitWords`). `required` says the
 * service insists on one, and `value` is null when there is nothing that can be sent.
 */
export function wordsFor(operation: { params: { name: string; type: string; required: boolean; maxLength?: number; oneOf?: string[] }[] }, text: string | null | undefined): { required: boolean; value: string | null } {
  const field = operation.params.find((param) => param.name === 'description');
  if (!field) return { required: false, value: null };
  if (field.type !== 'string' || field.oneOf || typeof text !== 'string') return { required: field.required, value: null };
  return { required: field.required, value: fitWords(text, field.maxLength ?? 500) };
}

/**
 * Trims, then cuts to at most `max` in length as the argument check counts it (UTF-16 units), but only between whole characters, so an
 * emoji is never split and never pushed over the limit. Nothing left means null.
 */
export function fitWords(text: string, max: number): string | null {
  let kept = '';
  for (const character of text.trim()) {
    if (kept.length + character.length > max) break;
    kept += character;
  }
  return kept.trim() || null;
}

export interface CreateJob {
  botId: string;
  serverId: string;
  requesterKey?: string;
  forOwner?: boolean;
  artifactId: string;
  amount: unknown;
  currency: string;
  description?: string | null;
}

/**
 * The owner asked a Brick to make a page take a payment. Only their own Brick, for their own page, through their own app that has a
 * payment contract; the amount and currency are frozen here. Asking again for the same page replaces the terms for NEW checkouts (the ones
 * already started keep what they were made with).
 */
export async function createPageJob(input: CreateJob): Promise<CreateJobOutcome> {
  const verdict = await checkAppUse(input.botId, input.serverId, { requesterKey: input.requesterKey, forOwner: input.forOwner, callId: `page-job:${input.artifactId}` });
  if (!verdict) return { status: 'refused', reason: 'gone' };
  if (!verdict.allowed) return { status: 'refused', reason: verdict.reason === 'not_owner' || verdict.reason === 'off' || verdict.reason === 'incomplete' ? verdict.reason : 'gone' };
  const row = await prisma.botMcpServer.findFirst({ where: { id: input.serverId, botId: input.botId }, include: { connection: true, bot: { select: { name: true } } } });
  const connection = row?.connection;
  if (!row || !connection || !connection.ownerId) return { status: 'refused', reason: 'gone' };
  const definition = connection.kind === 'direct' ? definitionOf(connection) : null;
  if (!definition?.payment) return { status: 'no_payments' };
  const artifact = await prisma.artifact.findUnique({ where: { id: input.artifactId }, select: { id: true, ownerId: true, kind: true, expiresAt: true, latestVersion: true, publishedVersion: true } });
  // Someone else's page, or one that is not there, is the same answer: the owner only ever changes their own
  if (!artifact || artifact.ownerId !== connection.ownerId || (artifact.expiresAt && artifact.expiresAt.getTime() <= Date.now())) return { status: 'not_found' };
  if (artifact.kind !== 'app' && artifact.kind !== 'page') return { status: 'bad_terms', message: 'Only a page that runs can take a payment' };
  const currency = String(input.currency ?? '').trim().toUpperCase();
  if (currencyExponent(currency) === null) return { status: 'bad_terms', message: 'That currency is not supported for payments yet' };
  const amountMinor = amountToMinor(input.amount, currency);
  if (amountMinor === null) return { status: 'bad_terms', message: 'The amount must be more than zero, with no more decimals than the currency has' };
  const description = input.description ? fitWords(input.description.replace(/[\u0000-\u001f\u007f]/g, ' '), 200) : null;
  // A service that insists on a description, or only takes some currencies, says so now, to the one setting this up, instead of every
  // checkout failing later where nobody sees it
  const made = definition.operations.find((candidate) => candidate.id === definition.payment?.create.operation);
  if (made) {
    const wording = wordsFor(made, description);
    if (wording.required && !wording.value) return { status: 'bad_terms', message: 'This payment service needs a short description of what is being paid for' };
    const currencyField = made.params.find((param) => param.name === definition.payment?.create.currency);
    if (currencyField?.oneOf && !currencyField.oneOf.some((allowed) => allowed.toUpperCase() === currency)) return { status: 'bad_terms', message: `This payment service takes only ${currencyField.oneOf.join(', ')}` };
  }
  const data = { ownerId: connection.ownerId, connectionId: connection.id, definitionHash: connection.definitionHash as string, artifactVersion: artifact.latestVersion, amountMinor, currency, description, madeByBot: row.bot.name.slice(0, 255), status: 'active', stoppedAt: null };
  const existing = await prisma.appPageJob.findUnique({ where: { artifactId: artifact.id }, select: { id: true } });
  const job = await prisma.appPageJob.upsert({ where: { artifactId: artifact.id }, create: { artifactId: artifact.id, ...data }, update: data });
  return { status: 'ok', job: jobView(job, connection.name), replaced: !!existing, waitsForPublish: waitsForPublish(job.artifactVersion, artifact.publishedVersion) };
}

/**
 * The terms were set on a version newer than the one the page's link shows (a draft after a publish): people who open it by its link are shown
 * the older version, so they cannot pay until the owner publishes again. A page never published shows its latest, so it never waits.
 */
export function waitsForPublish(termsVersion: number, publishedVersion: number | null): boolean {
  return publishedVersion !== null && publishedVersion < termsVersion;
}

/**
 * The version a checkout's buyer is shown: the latest for its owner and the people in its chat (`seesLatest`), and for everyone else what the
 * owner published, or the latest while nothing was ever published (game #2115).
 */
export function shownVersionFor(artifact: { latestVersion: number; publishedVersion: number | null }, seesLatest: boolean): number {
  return seesLatest || artifact.publishedVersion === null ? artifact.latestVersion : artifact.publishedVersion;
}

/**
 * The job a page has now, read back as it is saved (O4), for a Brick that did not get a clear answer to its write and must not write again
 * to find out. Only for the Brick's own app and the owner's own page: a job of another app, another owner or another page is "not found".
 * Counts no use of the app and writes nothing.
 */
export async function readPageJob(input: { botId: string; serverId: string; artifactId: string }): Promise<{ status: 'ok'; job: JobView; waitsForPublish: boolean } | { status: 'not_found' }> {
  const row = await prisma.botMcpServer.findFirst({ where: { id: input.serverId, botId: input.botId }, include: { connection: { select: { id: true, name: true, ownerId: true } } } });
  const connection = row?.connection;
  if (!row || !connection?.ownerId) return { status: 'not_found' };
  const job = await prisma.appPageJob.findUnique({ where: { artifactId: input.artifactId }, include: { artifact: { select: { publishedVersion: true } } } });
  if (!job || job.connectionId !== connection.id || job.ownerId !== connection.ownerId) return { status: 'not_found' };
  return { status: 'ok', job: jobView(job, connection.name), waitsForPublish: waitsForPublish(job.artifactVersion, job.artifact.publishedVersion) };
}

/** Stops a page taking payments: the owner's, and at once. A checkout already open can still finish, and is still checked. */
export async function stopPageJob(ownerId: string, jobId: string): Promise<boolean> {
  const result = await prisma.appPageJob.updateMany({ where: { id: jobId, ownerId, status: 'active' }, data: { status: 'stopped', stoppedAt: new Date() } });
  return result.count > 0;
}

export interface JobSummary extends JobView {
  title: string;
  /** Orders paid, and orders still open, for this page. */
  paid: number;
  open: number;
}

/** The pages of this person's that take payments through an app of theirs, for the Apps screen. Only theirs. */
export async function listPageJobs(ownerId: string, connectionId?: string): Promise<JobSummary[]> {
  const jobs = await prisma.appPageJob.findMany({
    where: { ownerId, ...(connectionId ? { connectionId } : {}) },
    include: { artifact: { select: { title: true } }, connection: { select: { name: true } } },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  });
  const ids = jobs.map((job) => job.id);
  const grouped = ids.length === 0 ? [] : await prisma.appPageOrder.groupBy({ by: ['jobId', 'status'], where: { jobId: { in: ids }, status: { in: ['paid', 'pending'] } }, _count: { _all: true } });
  const count = (jobId: string, status: string) => grouped.find((entry) => entry.jobId === jobId && entry.status === status)?._count._all ?? 0;
  return jobs.map((job) => ({ ...jobView(job, job.connection.name), title: job.artifact.title, paid: count(job.id, 'paid'), open: count(job.id, 'pending') }));
}

// ---- The visitor's side: one checkout ---------------------------------------------------------------------------

export type CheckoutOutcome =
  | { status: 'ok'; orderId: string; checkoutUrl: string; amount: string; currency: string; app: string; reused: boolean }
  /** `unsure`: an order may exist for this wish (the answer was lost, cut or late), so the host offers Check payment; without it nothing was made. */
  | { status: 'unavailable'; unsure?: true }
  /** The buyer is shown an older version of the page than the one the owner set these terms on: nothing was made or charged, the owner must publish again. */
  | { status: 'not_published' }
  /** The page the buyer has open shows an older version than the one these terms were set on, and a newer one is published: nothing was made; opening it again shows the terms. */
  | { status: 'page_changed' }
  | { status: 'limit' };

export interface StartCheckout {
  artifactId: string;
  /** Who is asking, in any stable form (an address and a browser, or a person's id): hashed before it is kept. */
  visitor: string;
  /**
   * The host's id for this tap, and who the buyer is (`accountBuyerKey` or `guestBuyerKey`). Together they make one purchase wish: the
   * same wish again, from the same tab after a lost answer or from another at the same moment, is given the order it made and never
   * another. Both or neither: a start with only one of them is treated as having neither (nothing to find it by).
   */
  intentId?: string | null;
  buyerKey?: string | null;
  /** Other keys the same buyer's earlier orders may be under (see `buyerKeysOf`): the wish is looked up under all of them. */
  alsoBuyerKeys?: string[];
  /**
   * The buyer is shown the page's latest version: its owner, or someone in its chat in the game. Left out, the buyer is shown what the owner
   * published (anyone who opens it by its link), so a checkout is only made with terms set on that version or an older one.
   */
  seesLatest?: boolean;
  /**
   * The version the buyer's open page shows, as the host that drew it says (Orbit's link page, the game's window). Terms set on a newer version
   * than that one are never charged on it: the owner may have published since the page was opened. A new order needs it: a start that does
   * not say it (null, an older host) is refused as a changed page, and a reload gives a page that says it. The same wish carrying on the order
   * it already made does not need it. It can only ever refuse a checkout, never allow one Orbit would refuse.
   */
  shownVersion: number | null;
}

const HOUR = 3_600_000;
/** What the rows that count a payment look in the hour's key calls hold in place of a person and a Brick. */
const LOOKUP_ROWS = 'page-payments';
/** How long past the service's own time limit a start is given before another request may take it over. */
const START_GRACE_MS = 2_000;
/** After an unsure start nothing is in flight any more: the same wish may be carried on (same id, same key at the service) this soon, not after a whole start time. */
const UNSURE_RETRY_MS = 5_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const CHECKOUT_JOB = { connection: true, artifact: { select: { expiresAt: true, latestVersion: true, publishedVersion: true } } } as const;
type CheckoutJob = Prisma.AppPageJobGetPayload<{ include: typeof CHECKOUT_JOB }>;

/**
 * Whether a checkout may start on this job right now, and with what: the definition it would use. The same test runs twice, once to
 * find the owner and once under the lock on the job and the app, so a change that committed in between is never missed.
 */
function checkoutTerms(job: CheckoutJob | null, seesLatest: boolean, displayed: number | null | 'order_made') {
  const connection = job?.connection;
  if (!job || job.status !== 'active' || !connection || connection.kind !== 'direct') return null;
  // A key marked as stopped is not a reason to refuse here: the call itself finds out, and a good call is what clears the mark
  if (job.artifact.expiresAt && job.artifact.expiresAt.getTime() <= Date.now()) return null;
  const definition = definitionOf(connection);
  // An app with test and live keys needs to know which one this key is: a payment is never taken with a key of a kind it could not tell
  if (definition?.modes && !connection.keyMode) return null;
  // A definition that changed since the owner asked for this is not the one they agreed to: payments wait for them to ask again
  if (!definition?.payment || job.definitionHash !== connection.definitionHash) return null;
  // Terms set on a version newer than the one this buyer is shown (a draft, while the link still shows what was published before) are not
  // the terms that page showed them: nothing is made until the owner publishes again
  if (shownVersionFor(job.artifact, seesLatest) < job.artifactVersion) return 'not_published' as const;
  // Nor are they the terms of the page the buyer has open when that page is older than they are (the owner published since it was opened),
  // or when the page never said which version it shows: only an order already made (its own terms kept) goes on without it
  if (displayed !== 'order_made' && (displayed === null || displayed < job.artifactVersion)) return 'page_changed' as const;
  return { job, connection, definition, payment: definition.payment };
}

/**
 * Every move an order makes is one guarded write and one line of history, together: the move happens only from the states it names (so two
 * things racing to move the same order cannot both win), and the line says what moved it. The row is locked and read INSIDE the
 * transaction, so the line (and a caller that needs to know, like "paid after it was closed") holds the state the order really left, not
 * what an earlier read saw. `lease` keeps a start attempt that was taken over from changing the order: only the attempt holding the order's
 * current `checkedAt` may write. Returns the state the order left, or null when this call did not move it.
 */
type OrderMove = {
  from: string | string[];
  to: string;
  reason: string | ((left: string) => string);
  data?: Prisma.AppPageOrderUpdateManyMutationInput;
  lease?: { checkedAt: Date | null };
};
async function moveOrder(orderId: string, move: OrderMove, db?: Prisma.TransactionClient): Promise<string | null> {
  const from = Array.isArray(move.from) ? move.from : [move.from];
  const run = async (tx: Prisma.TransactionClient): Promise<string | null> => {
    const rows = await tx.$queryRaw<{ status: string }[]>`SELECT "status" FROM "app_page_orders" WHERE "id" = ${orderId} FOR UPDATE`;
    const left = rows[0]?.status;
    if (!left || !from.includes(left)) return null;
    const moved = await tx.appPageOrder.updateMany({ where: { id: orderId, status: left, ...(move.lease ? { checkedAt: move.lease.checkedAt } : {}) }, data: { status: move.to, ...move.data } });
    if (moved.count !== 1) return null;
    await tx.appPageOrderEvent.create({ data: { orderId, fromStatus: left, toStatus: move.to, reason: typeof move.reason === 'function' ? move.reason(left) : move.reason } });
    return left;
  };
  return db ? run(db) : prisma.$transaction(run);
}

/** The order a purchase wish made, under any of the buyer's keys. */
const wishWhere = (artifactId: string, intentId: string, keys: string[]) => ({ artifactId, intentId, buyerKey: { in: keys } });

export async function startCheckout(input: StartCheckout, deps: GuardDeps = {}): Promise<CheckoutOutcome> {
  const intent = input.intentId && input.buyerKey ? { intentId: input.intentId, buyerKey: input.buyerKey } : null;
  const limits = await getBrickLimits();
  // The same wish again (a retry after a lost answer, a second tab): the order it made, found before anything else is asked or counted
  const keys = intent ? [intent.buyerKey, ...(input.alsoBuyerKeys ?? [])] : [];
  if (intent) {
    const made = await prisma.appPageOrder.findFirst({ where: wishWhere(input.artifactId, intent.intentId, keys), select: { id: true } });
    if (made) return carryOn(made.id, limits, { resume: true, wait: true }, deps);
  }
  const seesLatest = input.seesLatest === true;
  const displayed = typeof input.shownVersion === 'number' && Number.isSafeInteger(input.shownVersion) && input.shownVersion > 0 ? input.shownVersion : null;
  const pageJob = await prisma.appPageJob.findUnique({ where: { artifactId: input.artifactId }, include: CHECKOUT_JOB });
  const first = checkoutTerms(pageJob, seesLatest, displayed);
  if (!first) return { status: 'unavailable' };
  if (first === 'not_published' || first === 'page_changed') {
    // The same wish may have made its order a moment ago (an earlier try still on its way when this one looked): that order is its answer,
    // never a refusal that would leave the buyer unable to check a checkout that exists. The look waits on the owner's order lock, the one
    // every order is written under, so an earlier try that is writing its order right now has committed it (or given up) before this looks
    if (intent && pageJob) {
      const made = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`page-orders:${pageJob.ownerId}`}, 0))`;
        return tx.appPageOrder.findFirst({ where: wishWhere(input.artifactId, intent.intentId, keys), select: { id: true } });
      });
      if (made) return carryOn(made.id, limits, { resume: true, wait: true }, deps);
    }
    return { status: first };
  }
  const origin = ownOrigin();
  if (!origin) return { status: 'unavailable' };
  const hash = visitorHash(input.visitor);

  const started = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`page-orders:${first.job.ownerId}`}, 0))`;
    // The platform's own limit counts every owner's orders, so checkouts of different owners take turns at counting and writing the order,
    // or two of them at the same moment could both find room for the last one. Always after the owner's lock, in this one order
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('page-orders:platform', 0))`;
    // Two taps of one wish, at the same moment, wait here for each other: the second finds what the first made
    if (intent) {
      const made = await tx.appPageOrder.findFirst({ where: wishWhere(input.artifactId, intent.intentId, keys), select: { id: true } });
      if (made) return { again: made.id } as const;
    }
    // Holding both rows keeps the owner from replacing the terms, the app or its key until this order is written; what they hold NOW is what
    // the order and the request use, never what was read before the lock
    const held = await tx.$queryRaw<{ connectionId: string }[]>`SELECT "connection_id" AS "connectionId" FROM "app_page_jobs" WHERE "id" = ${first.job.id} AND "status" = 'active' FOR SHARE`;
    if (held.length === 0) return 'gone' as const;
    // The app to hold is the one the locked job names now: the owner may have pointed the page at another app since the first read
    const app = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "app_connections" WHERE "id" = ${held[0].connectionId} FOR SHARE`;
    if (app.length === 0) return 'gone' as const;
    const terms = checkoutTerms(await tx.appPageJob.findUnique({ where: { id: first.job.id }, include: CHECKOUT_JOB }), seesLatest, displayed);
    if (!terms) return 'gone' as const;
    if (terms === 'not_published' || terms === 'page_changed') return terms;
    const since = new Date(Date.now() - HOUR);
    // Checkouts are counted on their own: a Brick's use of its owner's own key is never limited and never shares this total (Khalid, 26 Nov 2026),
    // so however busy Bricks are, they can never use up what checkouts may do, and checkouts never use up what Bricks may do. Asks about payments
    // have their own budget (below)
    const [mine, page, visitor, platform] = await Promise.all([
      tx.appPageOrder.count({ where: { ownerId: terms.job.ownerId, createdAt: { gte: since } } }),
      tx.appPageOrder.count({ where: { jobId: terms.job.id, createdAt: { gte: since } } }),
      tx.appPageOrder.count({ where: { jobId: terms.job.id, visitorHash: hash, createdAt: { gte: since } } }),
      tx.appPageOrder.count({ where: { createdAt: { gte: since } } }),
    ]);
    if (visitor >= limits.checkoutsPerVisitor || page >= limits.checkoutsPerPage || mine >= limits.checkoutsPerOwner || platform >= limits.keyCallsPlatform) return 'limit' as const;
    const made = await tx.appPageOrder.create({
      data: {
        jobId: terms.job.id,
        ownerId: terms.job.ownerId,
        connectionId: terms.connection.id,
        artifactId: terms.job.artifactId,
        definitionHash: terms.job.definitionHash,
        amountMinor: terms.job.amountMinor,
        currency: terms.job.currency,
        mode: terms.connection.keyMode,
        status: 'creating',
        visitorHash: hash,
        intentId: intent?.intentId ?? null,
        buyerKey: intent?.buyerKey ?? null,
        // What the service is sent as the description, kept with the order: a start carried on later sends exactly what the first one did
        description: terms.job.description,
      },
    });
    await tx.appPageOrderEvent.create({ data: { orderId: made.id, fromStatus: null, toStatus: 'creating', reason: 'started' } });
    return { order: made, ...terms };
  });
  if (started === 'gone') return { status: 'unavailable' };
  if (started === 'not_published' || started === 'page_changed') return { status: started };
  if (started === 'limit') return { status: 'limit' };
  if (!('order' in started)) return carryOn(started.again, limits, { resume: true, wait: true }, deps);
  const { order, connection, definition, payment } = started;
  return runStart(order, { connection, definition, payment, origin }, { checkedAt: null }, deps);
}

type StartingOrder = { id: string; amountMinor: number; currency: string; mode: string | null; description: string | null };

/**
 * The call that makes the payment at the service, for an order already written. The order's own amount and currency are what is sent
 * (never the job's now), its id is the service's reference and idempotency key, so asking again for the same order gets the same payment.
 */
async function runStart(
  order: StartingOrder,
  using: { connection: NonNullable<CheckoutJob['connection']>; definition: Definition; payment: NonNullable<Definition['payment']>; origin: string },
  /** The attempt's hold on the order (the order's `checkedAt` when it took it): an attempt that was taken over can no longer change the order. */
  lease: { checkedAt: Date | null },
  deps: GuardDeps,
): Promise<CheckoutOutcome> {
  const { connection, definition, payment, origin } = using;
  const limits = await getBrickLimits();
  const fail = async (status: 'not_paid' | 'cant_confirm', reason: string) => {
    // Nobody was ever given a link for an order that fails here (the buyer is told "unavailable" and never learns its id), so nothing can be paid
    // against it: it is closed, and a try again makes a new order
    await moveOrder(order.id, { from: 'creating', to: status, reason, lease, data: status === 'not_paid' ? { closedAt: new Date() } : {} }).catch(() => undefined);
    return { status: 'unavailable' } as const;
  };
  // The service may or may not have made the payment (the answer never came, was cut, or said it had trouble): the order is NOT closed. It stays
  // as it is, tried again with the same id (which is the service's idempotency key, so the same payment and never a second) when the same wish
  // asks again or Check payment does, until its open time is up
  const unsure = async (reason: string) => {
    // This attempt is over, so nothing is in flight: the next ask (the same wish again, or Check payment) may carry the order on after a short
    // pause, and does not sit through a whole start time that nobody is using. `checkedAt` is also the lease, so it still changes.
    const heldFor = Math.max(0, limits.keyCallSeconds * 1000 + START_GRACE_MS - UNSURE_RETRY_MS);
    await moveOrder(order.id, { from: 'creating', to: 'creating', reason, lease, data: { checkedAt: new Date(Date.now() - heldFor) } }).catch(() => undefined);
    return { status: 'unavailable', unsure: true } as const;
  };
  const { create } = payment;
  const operation = definition.operations.find((candidate) => candidate.id === create.operation);
  if (!operation) return fail('not_paid', 'start_no_operation');
  // A key that cannot be read (damaged, or sealed with a key we no longer have) is a payment that cannot start: the order is closed, never left open
  let key: string;
  try {
    key = readKey(connection);
  } catch {
    return fail('not_paid', 'start_key_unreadable');
  }
  const args: Record<string, unknown> = {
    [create.amount]: Number(minorToText(order.amountMinor, order.currency)),
    // The service's own spelling of the currency when it lists the ones it takes (a service may list "usd"; the job keeps "USD")
    [create.currency]: operation.params.find((param) => param.name === create.currency)?.oneOf?.find((allowed) => allowed.toUpperCase() === order.currency) ?? order.currency,
    [create.orderRef]: order.id,
    [create.idempotentKey]: order.id,
    [create.returnUrl]: `${origin}/pay/done?o=${order.id}`,
    [create.notifyUrl]: `${origin}/api/app-pay/notice/${order.id}`,
  };
  // The service insists on a customer: a plain placeholder, never the buyer's name, which nobody gave us
  if (create.customerName) args[create.customerName] = 'Customer';
  // The owner's words go in only as the service's own description field allows: a string, trimmed, cut to its maxLength in whole
  // characters (never in the middle of one). A field that is not plain text or only takes set values, or words that are empty, are left
  // out, so a service's own limits never end a checkout.
  const wording = wordsFor(operation, order.description);
  if (wording.value) args.description = wording.value;

  const startedAt = new Date();
  let answer;
  try {
    const built = buildRequest(definition, operation.id, args, key);
    answer = await guardedRequest({ ...built, timeoutMs: limits.keyCallSeconds * 1000, maxBytes: limits.keyAnswerKb * 1024 }, deps);
  } catch (error) {
    // Never sent: nothing was made. Anything else (no connection, no answer in time, an answer too big) may have been made at the service
    if (error instanceof RequestError || (error instanceof GuardError && error.code === 'blocked')) return fail('not_paid', 'start_refused');
    if (error instanceof GuardError) {
      // The service did not answer: written on the App, as for a Brick's call (lib/app-direct/use.ts), until a good call clears it
      if (serviceDidNotAnswer(error)) await reportKeyNoAnswer(connection.id, startedAt);
      return unsure('start_unsure');
    }
    // Anything else is ours to look at, but the order is not left open on the way out
    await fail('not_paid', 'start_failed');
    throw error;
  }
  if (answer.redirected || answer.truncated) return unsure('start_unusable_answer');
  if (answer.status === 401 || answer.status === 403) {
    await reportConnectionSignIn(connection.id, { state: 'expired', status: answer.status }, startedAt).catch(() => undefined);
    return fail('not_paid', 'start_key_refused');
  }
  // The service had trouble (or asked to try again): it may have made the payment before it did
  if (answer.status >= 500 || answer.status === 408) return unsure('start_service_trouble');
  if (answer.status < 200 || answer.status >= 300) return fail('not_paid', 'start_service_refused');
  // The service accepted the key: a "stopped working" mark from an earlier refusal (even one for another operation) no longer holds
  await reportKeyWorked(connection.id, connection.keyVersion, startedAt).catch(() => undefined);
  let picked: unknown;
  try {
    picked = pickFields(JSON.parse(answer.body), operation.returns);
  } catch {
    return unsure('start_unreadable_answer');
  }
  const providerRef = valueAt(picked, create.idPath);
  const where = valueAt(picked, create.checkoutUrlPath);
  const checkoutUrl = typeof where === 'string' ? safeCheckoutUrl(where, payment.checkoutHosts) : null;
  // An address that carries the key is never kept or given out, and never rewritten either (it may be signed): the checkout is not used
  if (checkoutUrl && carriesKey(checkoutUrl, key)) return fail('cant_confirm', 'start_address_carries_key');
  if (typeof providerRef !== 'string' || !providerRef || providerRef.length > 255 || !checkoutUrl) return fail('cant_confirm', 'start_no_checkout');
  // Kept so a blocked pop-up can go on with the SAME order, and so a later look can find the payment
  const kept = await moveOrder(order.id, { from: 'creating', to: 'pending', reason: 'checkout_ready', lease, data: { providerRef, checkoutUrl } });
  // Closed by someone else while the service was being asked (a sweep that gave up on it), or taken over by a later attempt, which saves the
  // same checkout itself: this attempt gives nobody a link
  if (!kept) return { status: 'unavailable', unsure: true };
  return { status: 'ok', orderId: order.id, checkoutUrl, amount: minorToText(order.amountMinor, order.currency), currency: order.currency, app: definition.short, reused: false };
}

/**
 * A purchase wish that already has an order: where that order stands as an answer to "start". One that is open (or already paid) gives the
 * same order, with the same link; one still being started by another request is waited for, a little more than the service's own time limit;
 * one whose start was never finished (the server stopped, the answer was lost on the way) is carried on with the same id, which the service
 * knows, so it gives the same payment and not a second one. Never a second order for the same wish.
 */
async function carryOn(orderId: string, limits: Awaited<ReturnType<typeof getBrickLimits>>, how: { resume: boolean; wait: boolean }, deps: GuardDeps): Promise<CheckoutOutcome> {
  const unavailable = { status: 'unavailable' } as const;
  // An order exists for this wish: the buyer can be told to ask about it
  const maybeMade = { status: 'unavailable', unsure: true } as const;
  const patience = limits.keyCallSeconds * 1000 + START_GRACE_MS;
  // The last time an attempt held the order: when it was made, until an attempt writes `checkedAt` (a takeover sets it to now; an unsure start sets it
  // earlier, so the next ask may carry on soon). It is not the later of the two: a start that failed quickly has a recent `createdAt` and must not hold it.
  const lastTried = (order: { createdAt: Date; checkedAt: Date | null }) => (order.checkedAt ?? order.createdAt).getTime();
  for (let round = 0; round < 2; round += 1) {
    const order = await prisma.appPageOrder.findUnique({ where: { id: orderId }, include: { connection: true, job: { include: CHECKOUT_JOB } } });
    if (!order) return unavailable;
    if (order.status === 'pending' || order.status === 'paid') {
      if (!order.checkoutUrl) return maybeMade;
      const definition = order.connection && order.connection.kind === 'direct' ? definitionOf(order.connection) : null;
      return { status: 'ok', orderId: order.id, checkoutUrl: order.checkoutUrl, amount: minorToText(order.amountMinor, order.currency), currency: order.currency, app: definition?.short ?? order.connection?.name ?? 'the payment page', reused: true };
    }
    if (order.status !== 'creating') return maybeMade;
    // A start is only carried on for the buyer who made the wish (their own account or recovery code): a receipt link's code finds purchases
    // and never makes the service do anything
    if (!how.resume) return maybeMade;
    // Still being started by another request: it is waited for, and its answer is this one's answer (a Restore does not wait)
    const left = lastTried(order) + patience - Date.now();
    if (left > 0) {
      if (!how.wait) return maybeMade;
      await sleep(Math.min(250, left));
      round -= 1;
      continue;
    }
    // Its start is past what the service was given. It is taken over by one request only (the others wait for it), and only inside the
    // time an order may stay open
    if (Date.now() - order.createdAt.getTime() > limits.checkoutOpenHours * HOUR) {
      await moveOrder(order.id, { from: 'creating', to: 'not_paid', reason: 'start_never_finished', data: { closedAt: new Date(order.createdAt.getTime() + limits.checkoutOpenHours * HOUR) } }).catch(() => undefined);
      return maybeMade;
    }
    const cut = new Date(Date.now() - patience);
    const tookAt = new Date();
    const taken = await prisma.appPageOrder.updateMany({ where: { id: order.id, status: 'creating', OR: [{ checkedAt: null, createdAt: { lt: cut } }, { checkedAt: { lt: cut } }] }, data: { checkedAt: tookAt } });
    if (taken.count !== 1) continue;
    const origin = ownOrigin();
    // What the page was set up with when the wish was made must still hold: a stopped page, an app that is gone, a changed definition or a key
    // of another kind is not a payment to start now (the order is closed, and a new tap makes a new one)
    // The order already holds the terms its buyer was shown when it was made (its own amount, currency and words are what is sent), so the
    // version check is not made again here: a change of amount or currency since then still closes it, below
    const found = checkoutTerms(order.job, true, 'order_made');
    const terms = found === 'not_published' || found === 'page_changed' ? null : found;
    const fail = async (reason: string) => {
      await moveOrder(order.id, { from: 'creating', to: 'not_paid', reason, lease: { checkedAt: tookAt }, data: { closedAt: new Date() } }).catch(() => undefined);
      return maybeMade;
    };
    if (!origin || !terms) return fail('resume_page_changed');
    // The offer is the one the wish was made for: a price or currency the owner has changed since is a different offer, never started under
    // the old terms (the order is closed, and a new tap makes a new one at the new price). What is sent is what the order itself kept.
    if (terms.connection.id !== order.connectionId || terms.job.definitionHash !== order.definitionHash || terms.connection.keyMode !== order.mode) return fail('resume_terms_changed');
    if (terms.job.amountMinor !== order.amountMinor || terms.job.currency !== order.currency) return fail('resume_offer_changed');
    return runStart(order, { connection: terms.connection, definition: terms.definition, payment: terms.payment, origin }, { checkedAt: tookAt }, deps);
  }
  return maybeMade;
}

/**
 * Whether the key may be written anywhere in an address: as it is, percent-encoded, or hidden by escapes. An address that cannot be decoded
 * (a stray "%") could be hiding the key behind the broken escape, so it counts as carrying it.
 */
function carriesKey(address: string, key: string): boolean {
  if (!key) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(address);
  } catch {
    return true;
  }
  return address.includes(key) || decoded.includes(key) || address.includes(encodeURIComponent(key));
}

/** The address the buyer is sent to, only if it is https on the default port with no credentials, at a host the definition names. */
export function safeCheckoutUrl(raw: string, hosts: string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) ? url.toString() : null;
}

// ---- Is it paid ---------------------------------------------------------------------------------------------------

export type OrderState = 'checking' | 'paid' | 'not_paid' | 'cant_confirm';

/** What a visitor or the page may know about an order: only this. */
export interface OrderView {
  status: OrderState;
  /** Only for an open order: where the buyer pays, so a blocked pop-up can go on with the same one. */
  checkoutUrl: string | null;
  /** Made with a test key: no real money. Always said, never folded into "paid". */
  testPayment: boolean;
  /** The order this is about, for the host that asked (never for the page). */
  orderId: string;
  /**
   * Only with `checking`, for an order that is closed (or could not be confirmed) and that the service has not had the last word about: it may still have been
   * paid, so it is said to be still checked, never "not paid" or "no purchase". It has no link to go on with; the buyer is never asked to pay a second time for it.
   */
  longWait?: boolean;
  /** Only for an order in the long wait that is more than 90 days past its late window: its buyer is told no payment could be confirmed and to contact the page's owner with the time of the payment (the looks go on, monthly). */
  longWaitOver?: boolean;
  /** How long a host may wait before asking again, in milliseconds: short for a new order, longer the longer it has waited. */
  pollAfterMs: number;
}

/** When a look that was taken but could not be READ (an error, a refusal, a blip, no state, a key that cannot be read) is first tried again: soon, not at the order's age-based interval, so one bad moment of the service must not put a payment that may be real a week away. */
const UNREAD_RETRY_MS = 15 * 60 * 1000;

/**
 * How far apart the looks are for an order that may still have been paid but that nothing is waiting for (closed past the late-payment window, or
 * one that could not be confirmed): every 6 hours for the first 3 days, daily for a month, weekly until 90 days past the window, then monthly. It never stops: only the service saying
 * paid, a final failed state, or a payment for something else ends it, because a look that could not be made proves nothing about a payment, and a buyer who paid in advance must never need to pay twice.
 */
export function reconcileEveryMs(sinceWindowMs: number): number {
  const day = 24 * HOUR;
  return sinceWindowMs < 3 * day ? 6 * HOUR : sinceWindowMs < 33 * day ? day : sinceWindowMs < LONG_WAIT_WORDS_MS ? 7 * day : 30 * day;
}

/**
 * How long after the late window an order is still told to its buyer as "we're still checking your earlier payment". After this the buyer is told what a closed order says (if you paid, contact the page's owner with the
 * time of the payment) and the page stops refreshing, while the looks go on in the background, monthly, for as long as the order is unsettled.
 */
const LONG_WAIT_WORDS_MS = 90 * 24 * HOUR;

/** Whether an order in the long wait is past the point where its buyer is told to contact the page's owner (the looks do not stop). */
function pastLongWaitWords(order: { closedAt: Date | null; createdAt: Date }, limits: Awaited<ReturnType<typeof getBrickLimits>>, now: Date): boolean {
  const closedAt = order.closedAt ?? new Date(order.createdAt.getTime() + limits.checkoutOpenHours * HOUR);
  return now.getTime() - (closedAt.getTime() + limits.latePaymentHours * HOUR) >= LONG_WAIT_WORDS_MS;
}

/** 3 seconds for a new order, slowing to 15: a buyer who pays is seen quickly, and tabs left open on an order nobody pays cost little. */
export function pollAfterMs(createdAt: Date, now: Date = new Date()): number {
  const minutes = (now.getTime() - createdAt.getTime()) / 60_000;
  return minutes < 1 ? 3_000 : minutes < 5 ? 5_000 : minutes < 10 ? 10_000 : 15_000;
}

/** How often a look could not be made, for measuring on dev (since this process started). */
export const lookStats = { made: 0, spaced: 0, noRoom: 0, since: new Date() };

/** Answers that did not settle anything this time (the service was asked a moment ago, the hour's budget is spent, or the look itself failed): a notice that gets one is to be sent again later. */
const waiting = new WeakSet<OrderView>();
const later = (view: OrderView): OrderView => {
  waiting.add(view);
  return view;
};
export const isWaiting = (view: OrderView): boolean => waiting.has(view);

/**
 * Answers for an order that is closed and will never be asked about again (past the hours a late payment is still looked for, or nothing is left
 * to ask with): a page that refreshes itself to see a late payment stops refreshing on one. A look that only did not settle this time is not this.
 */
const over = new WeakSet<OrderView>();
const nothingMoreToAsk = (view: OrderView): OrderView => {
  over.add(view);
  return view;
};
export const checksHaveEnded = (view: OrderView): boolean => over.has(view);

/**
 * What a returning buyer (Check payment, the order poll) is told about an order the service has not had the last word about: a closed one, or one that could not be confirmed, still says
 * "checking" (it is, by its own schedule, for as long as it takes), never "not paid", because a payment made at the service after the order closed is real money. Only the
 * service's own final failed state (or a payment for something else) ends it, and that is read after the look just made.
 */
async function stillUnresolved(view: OrderView | null): Promise<OrderView | null> {
  if (!view || (view.status !== 'not_paid' && view.status !== 'cant_confirm')) return view;
  const order = await prisma.appPageOrder.findUnique({ where: { id: view.orderId }, select: { status: true, reconciled: true, providerRef: true, closedAt: true, createdAt: true } });
  // Both words an order the service has not had the last word about can wear: closed (not paid), or one that could not be confirmed (the app was gone, a key could not be read).
  // A cannot-confirm the service settled (reconciled: a payment for something else) is final and stays as it is
  if (!order || (order.status !== 'not_paid' && order.status !== 'cant_confirm') || order.reconciled || !order.providerRef) return view;
  // More than 90 days past the late window: no longer "we're still checking" (never for ever). The buyer is told what a closed order says, and the page stops refreshing; the looks go on in the background
  if (pastLongWaitWords(order, await getBrickLimits(), new Date())) {
    const told: OrderView = { ...view, checkoutUrl: null, longWaitOver: true, pollAfterMs: Math.max(view.pollAfterMs, 15_000) };
    over.add(told);
    return waiting.has(view) ? later(told) : told;
  }
  const said: OrderView = { ...view, status: 'checking', checkoutUrl: null, longWait: true, pollAfterMs: Math.max(view.pollAfterMs, 15_000) };
  return waiting.has(view) ? later(said) : said;
}

/** Thrown inside the look's transaction when its budget has no room, so the claim made in it is undone with it. */
class LookDenied extends Error {
  constructor(readonly room: 'owner' | 'platform') {
    super('no room for a look');
  }
}

const stateOf = (status: string): OrderState => (status === 'paid' ? 'paid' : status === 'not_paid' ? 'not_paid' : status === 'cant_confirm' ? 'cant_confirm' : 'checking');

/**
 * Asks the service about one order and moves it on. Safe to call as often as anyone likes (the visitor's page, the return page, the
 * service's notice): the service itself is asked at most once in `paymentCheckSeconds` (more for an order that has waited long) for an order, and "paid" is written once.
 */
export async function verifyOrder(orderId: string, deps: GuardDeps = {}, trace?: { contacted: boolean; noRoom?: 'owner' | 'platform' }, how: { background?: boolean; explicit?: boolean; /** Only the order's own time is read: an order past its open time ends, and nothing is asked of the service or of the looks' budget (the platform's room is spent). */ expireOnly?: boolean } = {}): Promise<OrderView | null> {
  const order = await prisma.appPageOrder.findUnique({ where: { id: orderId }, include: { connection: true, job: { select: { artifact: { select: { title: true } } } } } });
  if (!order) return null;
  const view = (status: string, mode: string | null = order.mode): OrderView => ({ status: stateOf(status), checkoutUrl: status === 'pending' ? order.checkoutUrl : null, testPayment: mode === 'test', orderId: order.id, pollAfterMs: pollAfterMs(order.createdAt) });
  const limits = await getBrickLimits();
  const now = new Date();
  // An order still being made, past the time the service had to answer, is one whose start never finished (the server stopped, or the answer
  // was lost): the buyer was never given a link for it, so nothing can have been paid against it yet. It is kept, because the same purchase
  // wish asked again carries it on (the order's id is the service's own key, so it gives the same payment), for as long as an order may stay
  // open. Past that it ends as not paid, with the same late window as any closed order, instead of being "checking" for ever.
  if (order.status === 'creating') {
    const openUntil = order.createdAt.getTime() + limits.checkoutOpenHours * HOUR;
    if (now.getTime() <= openUntil) return later(view('creating'));
    const ended = await moveOrder(order.id, { from: 'creating', to: 'not_paid', reason: 'start_never_finished', data: { closedAt: new Date(openUntil) } });
    return view(ended ? 'not_paid' : order.status);
  }
  const wasClosed = order.status === 'not_paid';
  // The late window runs from when the order was closed (an order closed because its time ran out closed at the end of that time)
  const closedAt = order.closedAt ?? new Date(order.createdAt.getTime() + limits.checkoutOpenHours * HOUR);
  const windowEndsAt = closedAt.getTime() + limits.latePaymentHours * HOUR;
  const pastWindow = wasClosed && now.getTime() > windowEndsAt;
  // An order the service has not had the last word about, with a payment that may exist at the service (it has its reference), is never given up on
  // because a look could not be made: a closed one past its late window, and one that could not be confirmed (the app was disconnected, the key
  // could not be read). It waits in a long, slow reconciliation, and a payment found there is counted once, like any late one.
  const reconciling = !order.reconciled && !!order.providerRef && (pastWindow || order.status === 'cant_confirm');
  // Paid is final, and so is cannot-confirm for a payment for something else (a person looks at it). A closed (not paid) order is asked about
  // again for a while: the buyer may still pay at the service after it was closed, and that is real money.
  if (order.status !== 'pending' && order.status !== 'not_paid' && !reconciling) return view(order.status);
  if (pastWindow && !reconciling) return nothingMoreToAsk(view(order.status));
  // What the order may still become: a pending one anything, a closed one only paid (or cannot-confirm for a payment that does not match)
  const open = { in: ['pending', 'not_paid', 'cant_confirm'] };
  const sinceWindow = Math.max(0, now.getTime() - windowEndsAt);
  // A look that is not read once is tried again soon; one that keeps not being read backs off (twice the time since the look before it, which was not read either) up to the order's own cadence
  // (monthly after 90 days), and never stops. A look before it that WAS read makes this the first failure of a streak
  const lastLookWasRead = !!order.lastReadAt && !!order.checkedAt && order.lastReadAt.getTime() >= order.checkedAt.getTime() - 1000;
  const streakGap = order.checkedAt && !lastLookWasRead ? Math.max(0, now.getTime() - order.checkedAt.getTime()) : 0;
  const unreadWait = (): number => Math.min(reconcileEveryMs(sinceWindow), Math.max(UNREAD_RETRY_MS, 2 * streakGap));
  // Only the look that claimed the order schedules its retry: an older look that fails after a newer one was taken (and read, and scheduled the order by its age) must not overwrite that schedule
  const retrySoon = async (): Promise<void> => {
    if (reconciling) await prisma.appPageOrder.updateMany({ where: { id: order.id, reconciled: false, checkedAt: now }, data: { nextLookAt: new Date(now.getTime() + unreadWait()) } }).catch(() => undefined);
  };
  // One look per order in a few seconds, whoever is asking. The longer an order has been waiting the further apart its looks are (a minute
  // more adds one more `paymentCheckSeconds`, up to sixty of them): a buyer who pays is seen at once, while tabs left open on an order nobody
  // is paying cost an owner a small and shrinking share of their looks instead of the same share for the whole open time.
  const spacing = limits.paymentCheckSeconds * Math.min(60, 1 + Math.floor((now.getTime() - order.createdAt.getTime()) / 60_000));
  // An order in the long wait is looked at by its own schedule when a sweep asks. A buyer pressing Check payment or Restore (`explicit`) is looked at as soon as the
  // ordinary spacing allows; every other asker (the done page that refreshes, the poll, the service's notice) keeps the age-grown spacing, so a tab left open on an order
  // that stays unpaid never spends the owner's looks at the short interval for ever
  const due = reconciling && how.background ? { OR: [{ nextLookAt: null }, { nextLookAt: { lte: now } }] } : { OR: [{ checkedAt: null }, { checkedAt: { lt: new Date(now.getTime() - (reconciling && how.explicit ? limits.paymentCheckSeconds : spacing) * 1000) } }] };
  // A look the service never answered in a way we can read (an error, a refusal, an answer with no state) is asked again, as before. But an
  // order that has been open longer than its time allows, and still cannot be read, is closed like any other that ran out of time: the buyer's
  // page stops waiting, and a payment that turns out to be real is still found by the later looks (a closed order is asked about for a while).
  // The look that was taken moved the order's own schedule on by its age-based interval (up to a week) BEFORE the service was asked: a look that is not read is tried again soon instead,
  // never a week later. The age-based interval stays for a look that was read
  // An order past its open time ends, whatever stopped it being looked at
  // An order whose time ran out closes as of WHEN its time ran out, never when somebody first looked: the late window, the long-wait schedule and the buyer's 90 days all start from `closedAt`, so a late first look must not start them late
  // (CodeRabbit on #1025, d522f4b3 pass, N12). Only a closing the service itself declared (`failed`) is dated by the look
  const openUntil = new Date(order.createdAt.getTime() + limits.checkoutOpenHours * HOUR);
  const endIfOutOfTime = async (): Promise<OrderView | null> => {
    if (!wasClosed && now.getTime() - order.createdAt.getTime() > limits.checkoutOpenHours * HOUR) {
      if (await moveOrder(order.id, { from: 'pending', to: 'not_paid', reason: 'open_time_ran_out', data: { closedAt: openUntil } })) return view('not_paid');
    }
    return null;
  };
  // The platform's room for looks is spent (the sweep says so): nothing is asked of the service and nothing is claimed, but an order past its open time still ends, so it is never left "checking" because looks ran short
  if (how.expireOnly) return (await endIfOutOfTime()) ?? later(view(order.status));
  // A look that cannot be made now (no app, no key to ask with) is a failed look that needs a person to connect the app again: it is counted as one (the claim is taken here, so `unreadLooks` and the
  // warning to Sentry see it, with the same backoff as any look that was not read), and the order's own schedule moves on so a sweep does not come back to it every pass. Never a budget denial: that one is
  // given back whole, because it recovers without anyone doing anything. Only from the state it was read in, so a look that came in meanwhile is never overwritten, and only when the look is DUE, by the same rule as a look
  // at a connected app (a page that refreshes inside the spacing counts nothing and moves nothing)
  const putOff = async () => {
    // The status the order was READ in is part of the claim: a look that marked it paid since (the paid move leaves `reconciled`, `checkedAt` and `checks` as they were) must not have a failed look recorded on it
    const counted = await prisma.appPageOrder
      .updateMany({ where: { id: order.id, status: order.status, reconciled: false, checkedAt: order.checkedAt, checks: order.checks, ...due }, data: { checkedAt: now, checks: { increment: 1 }, nextLookAt: new Date(now.getTime() + unreadWait()) } })
      .catch(() => null);
    if (counted && counted.count === 0) {
      // Nothing matched: either the look was not due (the order is as it was), or the order moved on since it was read. The state it is in NOW is the answer, never the snapshot
      const current = await prisma.appPageOrder.findUnique({ where: { id: order.id }, select: { status: true } }).catch(() => null);
      if (current && current.status !== order.status) return current.status === 'paid' ? view('paid') : later(view(current.status));
    }
    return later(view(order.status));
  };

  // An order whose app was disconnected (its connection row is gone) is asked about through the page's app as it is now, when the owner has connected
  // one again: what counts a payment is still the exact amount, currency, reference and mode, so another key can never make one up
  const nowJob = reconciling && !order.connection ? await prisma.appPageJob.findUnique({ where: { artifactId: order.artifactId }, include: { connection: true } }) : null;
  const connection = order.connection ?? (nowJob && nowJob.ownerId === order.ownerId ? nowJob.connection : null);
  // The page's app as it is NOW, not the one that made this order: its word counts only where it names a payment that matches (below), and never ends the order
  const substitute = !order.connection && !!connection;
  const definition = connection && connection.kind === 'direct' ? definitionOf(connection) : null;
  // The app was disconnected: what it said could not be checked any more, and a payment is never assumed. A definition that changed since
  // the checkout began (a new key, a new catalog) is not a reason to give up on a payment that may be real: the look below uses the
  // definition now in force, and "paid" still needs the exact amount, currency, reference and mode.
  if (!connection || !definition?.payment || !order.providerRef) {
    // No payment can exist for an order with no reference at the service. With one, the app may be connected again (or its key given again): it waits
    if (reconciling) return putOff();
    if (wasClosed) return nothingMoreToAsk(view(order.status));
    await moveOrder(order.id, { from: 'pending', to: 'cant_confirm', reason: 'app_gone' });
    return view('cant_confirm');
  }
  const unreadable = async (): Promise<OrderView> => {
    await retrySoon();
    return (await endIfOutOfTime()) ?? later(view(order.status));
  };
  const { lookup } = definition.payment;
  let key: string | null;
  try {
    key = readKey(connection);
  } catch {
    key = null;
  }
  // The claim and the look's budget are ONE transaction: the budget is decided before anything is kept, so a look that finds no room leaves the order exactly as it was (its schedule, its count of looks), with nothing to give back
  // afterwards that a failed write could leave undone. The claim is made on the state the order was read in (its last look, its count of looks and, in the long wait, its schedule): when a look came in between the read and now,
  // this one is not taken. Looks have a budget of their own, so that asking about payments can never use up what Bricks and checkouts may do with a key: what everyone may send an hour, and what one owner's services may be asked
  const outcome = await prisma
    .$transaction(async (tx) => {
      const taken = await tx.appPageOrder.updateMany({
        where: { id: order.id, status: open, ...(reconciling ? { reconciled: false, nextLookAt: order.nextLookAt } : {}), checkedAt: order.checkedAt, checks: order.checks, ...due },
        data: { checkedAt: now, checks: { increment: 1 }, ...(reconciling ? { nextLookAt: new Date(now.getTime() + reconcileEveryMs(sinceWindow)) } : {}) },
      });
      if (taken.count === 0) return 'spaced' as const;
      // A key that cannot be read still makes a claim (a failed look that needs a person), and asks for no room
      if (key === null) return 'unreadable' as const;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('key-calls:everyone', 0))`;
      const since = new Date(now.getTime() - HOUR);
      const [everyone, owners] = await Promise.all([
        tx.appKeyCall.count({ where: { ownerId: LOOKUP_ROWS, createdAt: { gte: since } } }),
        tx.appKeyCall.count({ where: { ownerId: LOOKUP_ROWS, callId: { startsWith: `look:${order.ownerId}:` }, createdAt: { gte: since } } }),
      ]);
      // Whose room is spent: the platform's (nobody has any) or this owner's alone (other owners may have room), so a sweep can go on to them. The claim above is undone with the transaction
      if (everyone >= limits.keyCallsPlatform) throw new LookDenied('platform');
      if (owners >= limits.paymentLooksPerOwner) throw new LookDenied('owner');
      // Not counted for the owner's own hourly allowance (a buyer's page asks, not the owner). One row for THIS attempt (the moment it claimed the order is part of its key), so an attempt whose commit was lost is
      // never found by the next one as a row that already exists
      await tx.appKeyCall.create({ data: { connectionId: connection.id, ownerId: LOOKUP_ROWS, botId: LOOKUP_ROWS, callId: `look:${order.ownerId}:${order.id}:${order.checks + 1}:${now.getTime()}`, operation: lookup.operation.slice(0, 60), state: 'done', outcome: 'ok' } });
      return 'room' as const;
    })
    .catch((error) => (error instanceof LookDenied ? error.room : ('error' as const)));
  if (outcome === 'spaced') {
    lookStats.spaced += 1;
    return later(view(order.status));
  }
  if (outcome === 'unreadable') {
    // A key that cannot be read cannot ask now: an open order can no longer be confirmed, and a closed one with a payment that may exist keeps waiting (the key may be given again). This IS a failed look,
    // one that needs a person (the key given again): it is tried again soon with the same backoff as any look that was not read, counted as one that was not read, and said by the warning to Sentry
    if (reconciling) {
      await retrySoon();
      return later(view(order.status));
    }
    if (wasClosed) return nothingMoreToAsk(view(order.status));
    await moveOrder(order.id, { from: 'pending', to: 'cant_confirm', reason: 'key_unreadable' });
    return view('cant_confirm');
  }
  if (outcome === 'error') {
    // The database did not answer: nothing was asked of the service. If the claim did commit (a commit whose answer was lost), it is this attempt's and nothing else's, so its schedule is the one of a look that was not read (soon, never
    // the age-based interval of a look that was made); if it did not, there is nothing to undo
    await retrySoon();
    return (await endIfOutOfTime()) ?? later(view(order.status));
  }
  // No room for looks: it waits, but an order past its open time still ends (it is not left "checking" because looks ran short). Nothing was claimed: the order is as due as it was, never backed off as if the service could not be read
  if (outcome !== 'room') {
    lookStats.noRoom += 1;
    if (trace) trace.noRoom = outcome;
    return (await endIfOutOfTime()) ?? later(view(order.status));
  }
  lookStats.made += 1;
  // This call asked the service (as against one that was spaced, or had no room): a sweep counts these and no others
  if (trace) trace.contacted = true;
  const startedAt = new Date();
  let answer;
  try {
    const built = buildRequest(definition, lookup.operation, { [lookup.idParam]: order.providerRef }, key as string);
    answer = await guardedRequest({ ...built, timeoutMs: limits.keyCallSeconds * 1000, maxBytes: limits.keyAnswerKb * 1024 }, deps);
  } catch (error) {
    if (serviceDidNotAnswer(error)) await reportKeyNoAnswer(connection.id, startedAt);
    if (error instanceof RequestError || error instanceof GuardError) return unreadable();
    throw error;
  }
  if (answer.status === 401 || answer.status === 403) {
    await reportConnectionSignIn(connection.id, { state: 'expired', status: answer.status }, startedAt).catch(() => undefined);
    return unreadable();
  }
  if (answer.redirected || answer.truncated || answer.status < 200 || answer.status >= 300) return unreadable();
  await reportKeyWorked(connection.id, connection.keyVersion, startedAt).catch(() => undefined);
  let record: unknown;
  try {
    const asked = definition.operations.find((candidate) => candidate.id === lookup.operation);
    record = pickFields(JSON.parse(answer.body), asked?.returns ?? []);
  } catch {
    return unreadable();
  }

  const status = valueAt(record, lookup.statusPath);
  // An answer that names no state at all is not an answer: asked again, never read as "still open" and left
  if (typeof status !== 'string' || !status) return unreadable();
  // The service answered in a way that could be read: kept for support ("last heard from the service")
  // Never moved backward: a look that was claimed earlier and answers later than a newer one must not make the newer, read look read as one that was not (its failure would then wait a week instead of minutes)
  await prisma.appPageOrder.updateMany({ where: { id: order.id, OR: [{ lastReadAt: null }, { lastReadAt: { lt: now } }] }, data: { lastReadAt: now } }).catch(() => undefined);
  const expired = now.getTime() - order.createdAt.getTime() > limits.checkoutOpenHours * HOUR;
  if (typeof status === 'string' && lookup.successStates.includes(status)) {
    const amount = valueAt(record, lookup.amountPath);
    const currency = valueAt(record, lookup.currencyPath);
    const reference = valueAt(record, lookup.orderPath);
    const live = lookup.livePath ? valueAt(record, lookup.livePath) : undefined;
    // A payment for a key with a known mode is only counted when the service says, as a yes or no, which mode it was made in
    // An app with test and live keys never counts a payment for a key of a kind it could not tell (no known mode on the order)
    const sameMode = definition.modes || order.mode ? typeof live === 'boolean' && !!order.mode && (live ? 'live' : 'test') === order.mode : true;
    const same =
      amountToMinor(typeof amount === 'number' || typeof amount === 'string' ? amount : null, order.currency) === order.amountMinor &&
      typeof currency === 'string' &&
      currency.toUpperCase() === order.currency &&
      reference === order.id &&
      sameMode;
    // A payment service other than the one that made the order is believed only when the reference, the amount, the currency (and the mode) all match: anything else it says
    // about this order (a payment for something else, too) ends nothing and marks nothing reconciled, so the order stays in the long wait and Check payment still asks
    if (substitute && !same) return later(view(order.status));
    // Completed at the service, but not for what we asked: never counted as paid
    if (!same) {
      // A payment for something else is for a person to look at: nothing more is asked automatically
      await moveOrder(order.id, { from: open.in, to: 'cant_confirm', reason: 'paid_for_something_else', data: { reconciled: true } });
      return view('cant_confirm');
    }
    // Late is decided by the state the order really left, read under the lock: a close that came in while the service was being asked counts, and
    // so does one found in the long wait (it was not paid when it was closed or could not be confirmed). Only the look that moved it tells the owner.
    const left = await moveOrder(order.id, { from: open.in, to: 'paid', reason: (was) => (was === 'pending' ? 'paid' : 'paid_late'), data: { paidAt: now } });
    if (left) await tellOwnerPaid(order, connection.name, definition.service !== 'custom', order.job?.artifact.title ?? 'your page', left !== 'pending');
    return view('paid');
  }
  // Only the service that made the order can say it did not complete: a substitute that says failed, or anything else but paid, leaves the order as it is (no end date, not
  // reconciled): it stays in the long wait and its age shows in the load view (`unconfirmed.oldestSeconds`) until the original service, or a person, settles it
  if (substitute) return later(view(order.status));
  const failed = typeof status === 'string' && lookup.failedStates.includes(status);
  // An order that could not be confirmed, and the service can be read again: it goes on as it would have (open while its time lasts, closed after)
  if (order.status === 'cant_confirm') {
    if (failed) {
      await moveOrder(order.id, { from: 'cant_confirm', to: 'not_paid', reason: 'service_says_failed', data: { closedAt: now, reconciled: true } });
      return view('not_paid');
    }
    if (!expired) return (await moveOrder(order.id, { from: 'cant_confirm', to: 'pending', reason: 'readable_again' })) ? view('pending') : view(order.status);
    // It closes as of when its time ran out (or when it was closed, if it already was): a readable answer that is not final must not start the late window, and the buyer's 90 days, over again
    const closedAt = order.closedAt ?? openUntil;
    return (await moveOrder(order.id, { from: 'cant_confirm', to: 'not_paid', reason: 'open_time_ran_out', data: { closedAt } })) ? view('not_paid') : view(order.status);
  }
  // A closed order that the service still does not call completed stays closed. When the service names a final failed state nothing more is asked
  // after the late window: that is its last word. Anything else (started, authorised only) is not, and stays in the long wait.
  if (wasClosed) {
    if (failed) await prisma.appPageOrder.updateMany({ where: { id: order.id, status: 'not_paid' }, data: { reconciled: true } }).catch(() => undefined);
    return failed && pastWindow ? nothingMoreToAsk(view('not_paid')) : view('not_paid');
  }
  // Only a state the service names as final closes an order early; anything else (started, authorised only, a state we never heard of) stays
  // open until it has been open too long. A payment that completes after that is still real money and is still counted above.
  if (!failed && !expired) return view('pending');
  const closed = await moveOrder(order.id, { from: 'pending', to: 'not_paid', reason: failed ? 'service_says_failed' : 'open_time_ran_out', data: { closedAt: failed ? now : openUntil, ...(failed ? { reconciled: true } : {}) } });
  return closed ? view('not_paid') : view('pending');
}

async function tellOwnerPaid(
  order: { id: string; ownerId: string; amountMinor: number; currency: string; mode: string | null },
  app: string,
  verified: boolean,
  title: string,
  late = false,
): Promise<void> {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const today = await prisma.appPageOrder.count({ where: { ownerId: order.ownerId, status: 'paid', paidAt: { gte: startOfDay } } });
    const amount = `${minorToText(order.amountMinor, order.currency)} ${order.currency}`;
    const test = order.mode === 'test';
    // A service we did not write the definition for says it itself: it is only what that service reports
    const said = verified ? `${app} confirmed it.` : `${app} reports this payment as completed.`;
    await addNotice({
      userId: order.ownerId,
      kind: 'page_payment',
      dedupeKey: `page-paid:${order.id}`,
      title: test ? `Test payment on ${title}` : `Someone just paid on ${title}`,
      body: `${amount}${test ? ' (a test payment, no real money)' : ''}. ${said}${late ? ' It came in after the checkout had closed.' : ''} ${today === 1 ? 'The first one today.' : `${today} paid today.`}`,
      badge: test ? 'Test' : 'Paid',
    });
  } catch (error) {
    // The payment is recorded either way: a notice that failed is only a notice
    console.error('[PagePayments] Could not tell the owner:', error instanceof Error ? error.message : 'unknown');
  }
}

/**
 * One order as the page the buyer returns to after paying shows it: the same look as any other asker's, then told as the Check payment and the order poll tell it: an order the service has
 * not had the last word about (closed, or one that could not be confirmed, with its reference at the service) is "checking", never "not paid" or "cannot confirm". Only the service's own last word ends it.
 */
export async function verifyOrderForReturnPage(orderId: string, deps: GuardDeps = {}): Promise<OrderView | null> {
  return stillUnresolved(await verifyOrder(orderId, deps));
}

/** One order as the visitor's page may ask about it: only on the page it was made for. */
export async function orderForArtifact(orderId: string, artifactId: string, deps: GuardDeps = {}, viewer?: { accountId: string | null }): Promise<OrderView | null> {
  const order = await prisma.appPageOrder.findUnique({ where: { id: orderId }, select: { artifactId: true, buyerKey: true } });
  if (!order || order.artifactId !== artifactId) return null;
  // An order made under an account is that account's to be told about: when another account (or nobody) is signed in now, on the same device, it
  // is answered like an order that is not there, so a checkout that was in flight for the account that left tells nothing to the one that came.
  // A guest's order (no account) is the browser's own, and stays reachable: guest recovery on a shared device is deliberate.
  if (viewer && order.buyerKey?.startsWith('acct:') && order.buyerKey !== (viewer.accountId ? accountBuyerKey(viewer.accountId) : null)) return null;
  return stillUnresolved(await verifyOrder(orderId, deps));
}

/** A page anyone with the link may open (shared by link, or Public): the public page's checkout is only for it, and only while it is there. */
export async function isOpenByLink(artifactId: string): Promise<boolean> {
  const artifact = await prisma.artifact.findUnique({ where: { id: artifactId }, select: { openScope: true, publishedVersion: true, expiresAt: true } });
  if (!artifact || (artifact.expiresAt && artifact.expiresAt.getTime() <= Date.now())) return false;
  // Public with nothing published is not there for a visitor (game #2115): nobody pays on a page they cannot see
  if (!(artifact.openScope === 'link' || (artifact.openScope === 'public' && artifact.publishedVersion !== null))) return false;
  // Nor on a page whose published version is gone: the visitor is told it is not there, so nothing is charged for it
  return !(await publishedVersionGone(artifactId, artifact.publishedVersion));
}

/** True when the owner published a version of this page and that version is no longer there (a visitor is then shown nothing, never the latest). */
async function publishedVersionGone(artifactId: string, publishedVersion: number | null): Promise<boolean> {
  if (publishedVersion === null) return false;
  const row = await prisma.artifactVersion.findUnique({ where: { artifactId_number: { artifactId, number: publishedVersion } }, select: { id: true } });
  return !row;
}

/** Whether a page is taking payments right now, for the page's own "Pay" button to know (nothing else about the job). */
export async function pageTakesPayments(artifactId: string): Promise<boolean> {
  const job = await prisma.appPageJob.findUnique({ where: { artifactId }, select: { status: true } });
  return job?.status === 'active';
}

// ---- Getting back to a purchase -----------------------------------------------------------------------------------

/**
 * "Check payment": where the buyer's ORIGINAL order for this purchase wish stands, asked of the service by Orbit itself (never of the page).
 * Found only by the page, the buyer and the wish together, so one buyer cannot ask about another's. An order whose start was never finished
 * is carried on with the same wish first (the same payment, not a second one), but only for the buyer who made it: `ownKeys` are their own
 * (account or recovery code), and an order found only through a receipt link's code is asked about and never started. Null when this buyer
 * has no order for that wish.
 */
export async function checkPurchase(input: { artifactId: string; buyerKeys: string[]; ownKeys?: string[]; intentId: string }, deps: GuardDeps = {}): Promise<OrderView | null> {
  const order = await prisma.appPageOrder.findFirst({ where: wishWhere(input.artifactId, input.intentId, input.buyerKeys), select: { id: true, status: true, buyerKey: true } });
  if (!order) return null;
  if (order.status === 'creating') await carryOn(order.id, await getBrickLimits(), { resume: ownsOrder(input.ownKeys ?? input.buyerKeys, order.buyerKey), wait: true }, deps);
  return stillUnresolved(await verifyOrder(order.id, deps, undefined, { explicit: true }));
}

/** Whether an order is under one of the buyer's OWN keys (their account or their browser's recovery code), as against one only a receipt link found. */
const ownsOrder = (ownKeys: string[], buyerKey: string | null): boolean => !!buyerKey && ownKeys.includes(buyerKey);

/**
 * The orders of a buyer that may still be asked about at the service: open ones, and closed ones inside the late-payment window, which runs
 * from when the order was closed (an order closed because its time ran out closed at the end of that time), the same as `verifyOrder`
 * reads it. An open order past its time is still a candidate, so a sweep that was down never leaves one open for ever.
 */
function askable(now: Date, limits: Awaited<ReturnType<typeof getBrickLimits>>, longWait = false): Prisma.AppPageOrderWhereInput {
  const lateWindow = limits.latePaymentHours * HOUR;
  const closedFrom = new Date(now.getTime() - lateWindow);
  // A closed order with no close time ran out of time at createdAt + open hours
  const unclosedFrom = new Date(now.getTime() - lateWindow - limits.checkoutOpenHours * HOUR);
  return {
    providerRef: { not: null },
    OR: [
      { status: 'pending' },
      { status: 'not_paid', closedAt: { gte: closedFrom } },
      { status: 'not_paid', closedAt: null, createdAt: { gte: unclosedFrom } },
      // The long wait (Restore asks about these too): an order the service has not had the last word about may still have been paid, however long ago it closed
      ...(longWait ? [{ reconciled: false, providerRef: { not: null }, status: { in: ['not_paid', 'cant_confirm'] } }] : []),
    ],
  };
}

/**
 * The orders in the long wait: the service has not had the last word about them, and they are past the late-payment window (or the service could not be
 * read for them). One definition, in positive conditions only (a NOT over a NULL close time would drop an unclosed order), for the sweep that looks at them and
 * the numbers that count them.
 */
function longWaitWhere(now: Date, limits: Awaited<ReturnType<typeof getBrickLimits>>): Prisma.AppPageOrderWhereInput {
  return {
    reconciled: false,
    providerRef: { not: null },
    OR: [
      { status: 'cant_confirm' },
      { status: 'not_paid', OR: [{ closedAt: { lt: new Date(now.getTime() - limits.latePaymentHours * HOUR) } }, { closedAt: null, createdAt: { lt: new Date(now.getTime() - (limits.latePaymentHours + limits.checkoutOpenHours) * HOUR) } }] },
    ],
  };
}

export interface Restored {
  /** paid: a verified paid order for what this page sells is this buyer's · checking: an order of theirs is still open · none: nothing of theirs */
  status: 'paid' | 'checking' | 'none';
  /** Only when paid: it was a test payment, no real money. A live purchase is always preferred, and a test one is never given as live. */
  testPayment: boolean;
  orderId: string | null;
  pollAfterMs: number;
  /** Only when paid: when it was paid, so the host can say "your purchase from 19 Nov is back". */
  paidAt?: string | null;
  /** Only when checking, for an order that is open at the service: where the buyer pays, so a reload or a lost pop-up can go on with the SAME order. */
  checkoutUrl?: string | null;
  /** Which proof found it: the buyer's own (account or recovery code), or only a receipt link's code. A purchase found by a receipt link is not given a new receipt. */
  via?: 'own' | 'receipt';
  /** Only when checking: the order is closed (or could not be confirmed) and the service has not had the last word about it. It has no link; it is still checked, never "no purchase". */
  longWait?: boolean;
  /** Only with `longWait`: more than 90 days past the late window, so the buyer is told to contact the page's owner with the time of the payment instead of "still checking" (the looks go on, monthly). */
  longWaitOver?: boolean;
}

/** The most orders of one buyer asked about at the service in one restore: the rest are asked about by the next. */
const RESTORE_LOOKS = 5;

/**
 * "Restore purchase": this buyer's verified, paid order for the page's offer as it stands (the job's amount and currency), found by the
 * buyer alone: never by a page-chosen id, a browser or "the last order for this page". Orders of theirs that are still open are asked
 * about at the service first (the ones asked about longest ago first, so repeated restores reach every one), so a payment made late is found.
 * A live purchase wins over a test one however many test ones are newer. An open order for the current offer is handed back with its own link;
 * one whose start never finished is carried on first, but only for a buyer's own keys, never through a receipt link's code.
 */
export async function restorePurchase(input: { artifactId: string; buyerKeys: string[]; ownKeys?: string[] }, deps: GuardDeps = {}): Promise<Restored> {
  const none = (status: Restored['status'] = 'none'): Restored => ({ status, testPayment: false, orderId: null, pollAfterMs: 3_000 });
  const own = input.ownKeys ?? input.buyerKeys;
  const viaOf = (buyerKey: string | null): 'own' | 'receipt' => (ownsOrder(own, buyerKey) ? 'own' : 'receipt');
  const limits = await getBrickLimits();
  const now = new Date();
  const due = new Date(now.getTime() - limits.paymentCheckSeconds * 1000);
  const offer = await prisma.appPageJob.findUnique({ where: { artifactId: input.artifactId }, select: { amountMinor: true, currency: true } });
  const forOffer = offer ? { amountMinor: offer.amountMinor, currency: offer.currency } : {};
  // The orders for what this page sells NOW are asked about first (the ones asked about longest ago first), so older orders at an old price, however many are still unresolved, can never use up every look
  // of a restore and leave the current offer's order handed back unchecked. What is left of the restore's looks goes to the older ones, which are also asked about in the background and by Check payment
  const ofBuyer = { artifactId: input.artifactId, buyerKey: { in: input.buyerKeys } };
  const spaced = [askable(now, limits, true), { OR: [{ checkedAt: null }, { checkedAt: { lt: due } }] }];
  const lookOrder = [{ checkedAt: { sort: 'asc' as const, nulls: 'first' as const } }, { createdAt: 'desc' as const }];
  const current = await prisma.appPageOrder.findMany({ where: { ...ofBuyer, ...forOffer, AND: spaced }, orderBy: lookOrder, take: RESTORE_LOOKS, select: { id: true } });
  const older =
    offer && current.length < RESTORE_LOOKS
      ? await prisma.appPageOrder.findMany({ where: { ...ofBuyer, NOT: forOffer, AND: spaced }, orderBy: lookOrder, take: RESTORE_LOOKS - current.length, select: { id: true } })
      : [];
  for (const order of [...current, ...older]) await verifyOrder(order.id, deps, undefined, { explicit: true }).catch(() => null);
  const mine = { artifactId: input.artifactId, buyerKey: { in: input.buyerKeys }, ...forOffer };
  // A live purchase is asked for first, so test ones however many and however new can never push it out
  const live = await prisma.appPageOrder.findFirst({ where: { ...mine, status: 'paid', OR: [{ mode: null }, { mode: { not: 'test' } }] }, orderBy: { paidAt: 'desc' }, select: { id: true, mode: true, paidAt: true, buyerKey: true } });
  const chosen = live ?? (await prisma.appPageOrder.findFirst({ where: { ...mine, status: 'paid' }, orderBy: { paidAt: 'desc' }, select: { id: true, mode: true, paidAt: true, buyerKey: true } }));
  if (chosen) return { status: 'paid', testPayment: chosen.mode === 'test', orderId: chosen.id, pollAfterMs: 3_000, paidAt: chosen.paidAt?.toISOString() ?? null, via: viaOf(chosen.buyerKey) };
  // Still open for what this page sells now: an older checkout at an old price is never handed back as this offer's (it stays asked about, by its own wish)
  const waiting = await prisma.appPageOrder.findFirst({ where: { ...mine, status: { in: ['creating', 'pending'] } }, orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true, status: true, checkoutUrl: true, buyerKey: true } });
  if (!waiting) {
    // ... then one that is closed (or not confirmable) for what this page sells now, with the service never having had the last word: it may still have been paid, so it is
    // handed back as still being checked and never as "nothing found". A newer long-wait order never outranks an open one
    const long = await prisma.appPageOrder.findFirst({ where: { ...mine, status: { in: ['not_paid', 'cant_confirm'] }, reconciled: false, providerRef: { not: null } }, orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true, closedAt: true, buyerKey: true } });
    if (!long) return none();
    return { status: 'checking', testPayment: false, orderId: long.id, pollAfterMs: Math.max(pollAfterMs(long.createdAt), 15_000), checkoutUrl: null, via: viaOf(long.buyerKey), longWait: true, ...(pastLongWaitWords(long, limits, new Date()) ? { longWaitOver: true } : {}) };
  }
  let checkoutUrl = waiting.status === 'pending' ? waiting.checkoutUrl : null;
  // An order whose start never finished (the server stopped, the answer was lost) goes on from here for its own buyer, with the same id: a reload
  // does not leave it with no way forward
  if (waiting.status === 'creating' && ownsOrder(own, waiting.buyerKey)) {
    const resumed = await carryOn(waiting.id, limits, { resume: true, wait: false }, deps).catch(() => null);
    if (resumed?.status === 'ok') checkoutUrl = resumed.checkoutUrl;
  }
  return { status: 'checking', testPayment: false, orderId: waiting.id, pollAfterMs: pollAfterMs(waiting.createdAt), checkoutUrl, via: viaOf(waiting.buyerKey) };
}

// ---- Orders that nobody is watching ---------------------------------------------------------------------------------

export interface OrderSweep {
  /** Orders asked about at the service (each is still limited as always: once in a few seconds, further apart the longer it waits). */
  looked: number;
  /** Orders whose start never finished and whose time ran out: closed, with the late window as for any other. */
  ended: number;
  /** Orders that left an open state in this pass. */
  moved: number;
}

const SWEEP_BATCH = 50;
/** An order is left alone by a sweep this long after anyone asked about it: the buyer's own page and the service's notices do the quick part. */
const SWEEP_QUIET_MS = 5 * 60_000;

/** The most pages of candidates one pass reads when owners without room are being skipped: a bound, so a pass can never scan the table. */
const SWEEP_ROUNDS = 20;

/** Whether the PLATFORM's room for looks is spent in this sweep: once it is, no pass asks the service for anything more, and orders are only given their own time. */
interface Room {
  platformSpent: boolean;
}

/**
 * One pass of a sweep: up to SWEEP_BATCH orders are asked about, the next due first. An order that finds no room in its OWNER's hourly allowance stays due exactly as it was (nothing is claimed for it),
 * and the pass goes on with the orders of every other owner (never the same first fifty over and over while one owner's room is spent). No room in the PLATFORM's allowance means nobody has any: nothing more is
 * asked of the service in this sweep, but the orders of the batch that was read still get their own time read (`expireOnly`: a pending order past its open time ends, one that is closed or not past it is left, and
 * none of them uses the looks' budget), so looks running short never leaves an order "checking" past its time. At most SWEEP_ROUNDS pages are read.
 */
async function sweepPass(
  sweep: OrderSweep,
  where: () => Prisma.AppPageOrderWhereInput,
  orderBy: Prisma.AppPageOrderOrderByWithRelationInput[],
  how: { background?: boolean },
  moved: (view: OrderView, before: string) => boolean,
  failure: string,
  deps: GuardDeps,
  room: Room,
  /** Pending orders created before this have run out of their open time: they end without a look (see below). Only the pass that reads pending orders has them. */
  expiredBefore?: Date,
): Promise<void> {
  const noRoomOwners: string[] = [];
  try {
    await readPages(sweep, where, orderBy, how, moved, failure, deps, room, noRoomOwners);
  } finally {
    // An owner whose room is spent is left out of the lookups above, but an expired pending checkout of theirs still ends: its own time is read (`expireOnly`), nothing is asked of the service and no room is used.
    // Without this, a closed order that was refused first would leave every later expired pending order of that owner "checking" in each sweep, for as long as the owner stays at the cap
    if (expiredBefore && noRoomOwners.length > 0) {
      const left = await prisma.appPageOrder
        .findMany({ where: { AND: [where(), { ownerId: { in: noRoomOwners }, status: 'pending', createdAt: { lt: expiredBefore } }] }, orderBy, take: SWEEP_BATCH, select: { id: true, status: true } })
        .catch(() => []);
      for (const order of left) {
        const view = await verifyOrder(order.id, deps, undefined, { ...how, expireOnly: true }).catch((error) => {
          console.error(`[PagePayments] ${failure}`, error instanceof Error ? error.message : 'unknown');
          return null;
        });
        if (view && moved(view, order.status)) sweep.moved += 1;
      }
    }
  }
}

async function readPages(
  sweep: OrderSweep,
  where: () => Prisma.AppPageOrderWhereInput,
  orderBy: Prisma.AppPageOrderOrderByWithRelationInput[],
  how: { background?: boolean },
  moved: (view: OrderView, before: string) => boolean,
  failure: string,
  deps: GuardDeps,
  room: Room,
  noRoomOwners: string[],
): Promise<void> {
  let asked = 0;
  for (let round = 0; round < SWEEP_ROUNDS && asked < SWEEP_BATCH; round += 1) {
    const page = await prisma.appPageOrder.findMany({
      where: noRoomOwners.length > 0 ? { AND: [where(), { ownerId: { notIn: noRoomOwners } }] } : where(),
      orderBy,
      take: SWEEP_BATCH - asked,
      select: { id: true, status: true, ownerId: true },
    });
    if (page.length === 0) return;
    let skipped = false;
    for (const order of page) {
      if (noRoomOwners.includes(order.ownerId)) {
        skipped = true;
        continue;
      }
      asked += 1;
      const before = order.status;
      const trace: { contacted: boolean; noRoom?: 'owner' | 'platform' } = { contacted: false };
      const view = await verifyOrder(order.id, deps, trace, room.platformSpent ? { ...how, expireOnly: true } : how).catch((error) => {
        console.error(`[PagePayments] ${failure}`, error instanceof Error ? error.message : 'unknown');
        return null;
      });
      // What the look did to the order is counted FIRST, whatever the budget said: an order that ran out of time while no room was left did move
      if (view) {
        if (trace.contacted) sweep.looked += 1;
        if (moved(view, before)) sweep.moved += 1;
      }
      if (trace.noRoom === 'platform') {
        // The rest of this batch is read for its own time only, and no page after it is read
        room.platformSpent = true;
        continue;
      }
      if (trace.noRoom === 'owner') {
        noRoomOwners.push(order.ownerId);
        // This one asked nothing: it does not use up the pass's share
        asked -= 1;
        skipped = true;
      }
    }
    // The platform's room is spent: what was read has had its time read, and no more is read
    if (room.platformSpent) return;
    // A page with nothing skipped and fewer orders than asked for has reached the end of what is due
    if (!skipped) return;
  }
}

/**
 * Safe to run any time, twice at once: orders nobody is watching (the buyer closed the page, the browser never came back, the service's
 * notice never arrived) are asked about at the service by this, and ones whose start never finished are ended when their open time is up. Never
 * starts a payment, and never marks one paid except through the same verified look as everything else.
 */
export async function sweepPageOrders(now: Date = new Date(), deps: GuardDeps = {}): Promise<OrderSweep> {
  const limits = await getBrickLimits();
  const sweep: OrderSweep = { looked: 0, ended: 0, moved: 0 };
  const openUntil = new Date(now.getTime() - limits.checkoutOpenHours * HOUR);
  const never = await prisma.appPageOrder.findMany({ where: { status: 'creating', createdAt: { lt: openUntil } }, orderBy: { createdAt: 'asc' }, take: SWEEP_BATCH, select: { id: true, createdAt: true } });
  for (const order of never) {
    if (await moveOrder(order.id, { from: 'creating', to: 'not_paid', reason: 'start_never_finished', data: { closedAt: new Date(order.createdAt.getTime() + limits.checkoutOpenHours * HOUR) } }).catch(() => false)) sweep.ended += 1;
  }
  const quiet = new Date(now.getTime() - SWEEP_QUIET_MS);
  const room: Room = { platformSpent: false };
  // The long wait is a pass of its own, by each order's own schedule, so orders that are due never wait behind ones that are not
  await sweepPass(
    sweep,
    () => ({ AND: [longWaitWhere(now, limits), { OR: [{ nextLookAt: null }, { nextLookAt: { lte: now } }] }] }),
    [{ nextLookAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    { background: true },
    (view, before) => stateOf(before) !== view.status,
    'A reconciliation look failed:',
    deps,
    room,
  );
  await sweepPass(
    sweep,
    () => ({ AND: [askable(now, limits), { OR: [{ checkedAt: null }, { checkedAt: { lt: quiet } }] }] }),
    [{ checkedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    {},
    // Only a call that asked the service is a look: one that was spaced, or had no room, is not counted
    (view, before) => stateOf(before) !== view.status && !(before === 'pending' && view.status === 'checking'),
    'A sweep look failed:',
    deps,
    room,
    openUntil,
  );
  return sweep;
}

/**
 * How many orders in the long wait were looked at and NOT read: more than two looks and no good read at all, or the last good read an hour or more before the last look. Every such order counts, however
 * long ago it was last looked at (an order whose looks have backed off to weekly or monthly is still one the service cannot be read for, until a look is read). The long wait is `longWaitWhere`, written here
 * in SQL because two columns of a row are compared.
 */
async function unreadLookCount(now: Date, limits: Awaited<ReturnType<typeof getBrickLimits>>): Promise<number> {
  const lateFor = new Date(now.getTime() - limits.latePaymentHours * HOUR);
  const unclosedFor = new Date(now.getTime() - (limits.latePaymentHours + limits.checkoutOpenHours) * HOUR);
  const rows = await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS n FROM "app_page_orders"
    WHERE "reconciled" = false AND "provider_ref" IS NOT NULL AND "checked_at" IS NOT NULL
      AND ("status" = 'cant_confirm' OR ("status" = 'not_paid' AND ("closed_at" < ${lateFor} OR ("closed_at" IS NULL AND "created_at" < ${unclosedFor}))))
      AND (("last_read_at" IS NULL AND "checks" >= 3) OR "last_read_at" < "checked_at" - interval '1 hour')`);
  return rows[0]?.n ?? 0;
}

export interface PaymentLoad {
  takenAt: string;
  /** Orders that are open now, and how long the oldest has been. */
  pending: number;
  oldestPendingSeconds: number | null;
  /** Orders still being started, and how long the oldest has been (a number that stays high means starts are being lost). */
  starting: number;
  oldestStartingSeconds: number | null;
  /** Looks at the service in the last hour, against what is allowed for everyone. */
  looksLastHour: number;
  looksAllowedPerHour: number;
  /** This process since it started: looks made, looks left for later because the order was asked about a moment ago, and for want of room. */
  looks: { made: number; spaced: number; noRoom: number; since: string };
  /** How long, in the last day, an order took from being made to being found paid. */
  recoveryLastDay: { paid: number; p50Seconds: number | null; p95Seconds: number | null };
  /** Orders in the long wait (closed past their late window, or not confirmable, and the service has not had the last word): how many, how long the oldest has waited, and how many have never once been read. An age that keeps growing is an alert. */
  unconfirmed: {
    count: number;
    oldestSeconds: number | null;
    /** Never once read in a way that could be understood (the service may have been unreadable for all of its time). */
    neverRead: number;
    /** Never once asked about at all (the schedule never reached it): a stalled sweep shows here, as against a service that cannot be read. */
    neverChecked: number;
    /** Whose scheduled look is more than an hour late (the sweep is behind or stopped), as against an order that is merely old and looked at on time. */
    overdue: number;
    /** Orders whose last look was not read (more than two looks and no good read, or the last good read an hour or more before the last look), however long ago that look was: the payment service cannot be read for them. */
    unreadLooks: number;
    /**
     * Why the looks are STALLED, if they are: `overdue` (a scheduled look is more than an hour late), `never_checked` (an order the schedule never reached) or `unreadable` (looks are made and not read).
     * Empty while every long-wait order is looked at on schedule, however old it is: age alone is never a reason, an order waiting its month shows only in `count` and `oldestSeconds`. This is what the alert is on.
     */
    stalled: Array<'overdue' | 'never_checked' | 'unreadable'>;
  };
  /** Seconds since any order was last read at the service in a way that could be understood (null when none ever was): a number that keeps growing while orders wait is a service that cannot be read or a stalled worker. */
  sinceLastReadSeconds: number | null;
}

/** What dev is measured with (GPT's evidence point 4): active orders, the oldest unsettled order, looks throttled, how long recovery takes. */
export async function pagePaymentLoad(now: Date = new Date()): Promise<PaymentLoad> {
  const limits = await getBrickLimits();
  const day = new Date(now.getTime() - 24 * HOUR);
  const hour = new Date(now.getTime() - HOUR);
  const longWait = longWaitWhere(now, limits);
  const lateBy = new Date(now.getTime() - HOUR);
  const [pending, oldestPending, starting, oldestStarting, looksLastHour, paid, unconfirmed, oldestUnconfirmed, neverRead, neverChecked, overdue, lastRead, recentLooks] = await Promise.all([
    prisma.appPageOrder.count({ where: { status: 'pending' } }),
    prisma.appPageOrder.findFirst({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    prisma.appPageOrder.count({ where: { status: 'creating' } }),
    prisma.appPageOrder.findFirst({ where: { status: 'creating' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    prisma.appKeyCall.count({ where: { ownerId: LOOKUP_ROWS, createdAt: { gte: hour } } }),
    prisma.appPageOrder.findMany({ where: { status: 'paid', paidAt: { gte: day } }, select: { createdAt: true, paidAt: true }, take: 5_000 }),
    prisma.appPageOrder.count({ where: longWait }),
    prisma.appPageOrder.findFirst({ where: longWait, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    prisma.appPageOrder.count({ where: { ...longWait, lastReadAt: null } }),
    prisma.appPageOrder.count({ where: { ...longWait, checkedAt: null } }),
    // Due an hour ago or more and still not looked at. An order never scheduled counts once it has been in the long wait for an hour
    prisma.appPageOrder.count({
      where: { AND: [longWait, { OR: [{ nextLookAt: { lt: lateBy } }, { nextLookAt: null, OR: [{ closedAt: { lt: new Date(lateBy.getTime() - limits.latePaymentHours * HOUR) } }, { status: 'cant_confirm', OR: [{ checkedAt: { lt: lateBy } }, { checkedAt: null, createdAt: { lt: lateBy } }] }, { closedAt: null, status: 'not_paid', createdAt: { lt: new Date(lateBy.getTime() - (limits.latePaymentHours + limits.checkoutOpenHours) * HOUR) } }] }] }] },
    }),
    prisma.appPageOrder.findFirst({ where: { lastReadAt: { not: null } }, orderBy: { lastReadAt: 'desc' }, select: { lastReadAt: true } }),
    unreadLookCount(now, limits),
  ]);
  const unreadLooks = recentLooks;
  const stalled: Array<'overdue' | 'never_checked' | 'unreadable'> = [...(overdue > 0 ? (['overdue'] as const) : []), ...(neverChecked > 0 ? (['never_checked'] as const) : []), ...(unreadLooks > 0 ? (['unreadable'] as const) : [])];
  const seconds = (from: Date | undefined) => (from ? Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000)) : null);
  const spans = paid.flatMap((order) => (order.paidAt ? [Math.max(0, Math.round((order.paidAt.getTime() - order.createdAt.getTime()) / 1000))] : [])).sort((a, b) => a - b);
  const at = (share: number) => (spans.length === 0 ? null : spans[Math.min(spans.length - 1, Math.ceil(spans.length * share) - 1)]);
  return {
    takenAt: now.toISOString(),
    pending,
    oldestPendingSeconds: seconds(oldestPending?.createdAt),
    starting,
    oldestStartingSeconds: seconds(oldestStarting?.createdAt),
    looksLastHour,
    looksAllowedPerHour: limits.keyCallsPlatform,
    looks: { made: lookStats.made, spaced: lookStats.spaced, noRoom: lookStats.noRoom, since: lookStats.since.toISOString() },
    recoveryLastDay: { paid: spans.length, p50Seconds: at(0.5), p95Seconds: at(0.95) },
    unconfirmed: { count: unconfirmed, oldestSeconds: seconds(oldestUnconfirmed?.createdAt), neverRead, neverChecked, overdue, unreadLooks, stalled },
    sinceLastReadSeconds: seconds(lastRead?.lastReadAt ?? undefined),
  };
}
