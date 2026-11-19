import { createHmac } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getBrickLimits } from '@/lib/bot-limits';
import { checkAppUse } from '@/lib/app-connections';
import { addNotice } from '@/lib/notices';
import { reportConnectionSignIn, reportKeyWorked } from '@/lib/tool-signin';
import { resolveExpectedLoginOrigin } from '@/lib/auth';
import { definitionSchema, hashDefinition, type Definition } from '@/lib/app-direct/definition';
import { guardedRequest, GuardError, type GuardDeps } from '@/lib/app-direct/guard';
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

// ---- The owner's side: a job per page --------------------------------------------------------------------------

export interface JobView {
  id: string;
  artifactId: string;
  app: string;
  amount: string;
  currency: string;
  description: string | null;
  status: 'active' | 'stopped';
}

const jobView = (job: { id: string; artifactId: string; amountMinor: number; currency: string; description: string | null; status: string }, app: string): JobView => ({
  id: job.id,
  artifactId: job.artifactId,
  app,
  amount: minorToText(job.amountMinor, job.currency),
  currency: job.currency,
  description: job.description,
  status: job.status === 'stopped' ? 'stopped' : 'active',
});

export type CreateJobOutcome =
  | { status: 'ok'; job: JobView; replaced: boolean }
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
  const artifact = await prisma.artifact.findUnique({ where: { id: input.artifactId }, select: { id: true, ownerId: true, kind: true, expiresAt: true, latestVersion: true } });
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
  return { status: 'ok', job: jobView(job, connection.name), replaced: !!existing };
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
  | { status: 'ok'; orderId: string; checkoutUrl: string; amount: string; currency: string; app: string }
  | { status: 'unavailable' }
  | { status: 'limit' };

export interface StartCheckout {
  artifactId: string;
  /** Who is asking, in any stable form (an address and a browser, or a person's id): hashed before it is kept. */
  visitor: string;
}

const HOUR = 3_600_000;
/** What the rows that count a payment look in the hour's key calls hold in place of a person and a Brick. */
const LOOKUP_ROWS = 'page-payments';

type CheckoutJob = Prisma.AppPageJobGetPayload<{ include: { connection: true; artifact: { select: { expiresAt: true } } } }>;

/**
 * Whether a checkout may start on this job right now, and with what: the definition it would use. The same test runs twice, once to
 * find the owner and once under the lock on the job and the app, so a change that committed in between is never missed.
 */
function checkoutTerms(job: CheckoutJob | null) {
  const connection = job?.connection;
  if (!job || job.status !== 'active' || !connection || connection.kind !== 'direct') return null;
  // A key marked as stopped is not a reason to refuse here: the call itself finds out, and a good call is what clears the mark
  if (job.artifact.expiresAt && job.artifact.expiresAt.getTime() <= Date.now()) return null;
  const definition = definitionOf(connection);
  // An app with test and live keys needs to know which one this key is: a payment is never taken with a key of a kind it could not tell
  if (definition?.modes && !connection.keyMode) return null;
  // A definition that changed since the owner asked for this is not the one they agreed to: payments wait for them to ask again
  if (!definition?.payment || job.definitionHash !== connection.definitionHash) return null;
  return { job, connection, definition, payment: definition.payment };
}

export async function startCheckout(input: StartCheckout, deps: GuardDeps = {}): Promise<CheckoutOutcome> {
  const first = checkoutTerms(await prisma.appPageJob.findUnique({ where: { artifactId: input.artifactId }, include: { connection: true, artifact: { select: { expiresAt: true } } } }));
  if (!first) return { status: 'unavailable' };
  const origin = ownOrigin();
  if (!origin) return { status: 'unavailable' };
  const limits = await getBrickLimits();
  const hash = visitorHash(input.visitor);

  const started = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`page-orders:${first.job.ownerId}`}, 0))`;
    // The platform's own limit counts every owner's orders, so checkouts of different owners take turns at counting and writing the order,
    // or two of them at the same moment could both find room for the last one. Always after the owner's lock, in this one order
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('page-orders:platform', 0))`;
    // The count of key calls below is the one every key call takes its turn on (lib/app-direct/use.ts): without this lock a call and a checkout could both
    // count one under the platform's limit and both take it. After the platform lock and before the counts; use.ts takes no page-orders lock, so no cycle
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('key-calls:everyone', 0))`;
    // Holding both rows keeps the owner from replacing the terms, the app or its key until this order is written; what they hold NOW is what
    // the order and the request use, never what was read before the lock
    const held = await tx.$queryRaw<{ connectionId: string }[]>`SELECT "connection_id" AS "connectionId" FROM "app_page_jobs" WHERE "id" = ${first.job.id} AND "status" = 'active' FOR SHARE`;
    if (held.length === 0) return 'gone' as const;
    // The app to hold is the one the locked job names now: the owner may have pointed the page at another app since the first read
    const app = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "app_connections" WHERE "id" = ${held[0].connectionId} FOR SHARE`;
    if (app.length === 0) return 'gone' as const;
    const terms = checkoutTerms(await tx.appPageJob.findUnique({ where: { id: first.job.id }, include: { connection: true, artifact: { select: { expiresAt: true } } } }));
    if (!terms) return 'gone' as const;
    const since = new Date(Date.now() - HOUR);
    const [mine, page, visitor, platform, calls] = await Promise.all([
      tx.appPageOrder.count({ where: { ownerId: terms.job.ownerId, createdAt: { gte: since } } }),
      tx.appPageOrder.count({ where: { jobId: terms.job.id, createdAt: { gte: since } } }),
      tx.appPageOrder.count({ where: { jobId: terms.job.id, visitorHash: hash, createdAt: { gte: since } } }),
      tx.appPageOrder.count({ where: { createdAt: { gte: since } } }),
      // Asks about payments are counted apart (below), so they can never use up what checkouts and Bricks may do
      tx.appKeyCall.count({ where: { createdAt: { gte: since }, NOT: { ownerId: LOOKUP_ROWS } } }),
    ]);
    if (visitor >= limits.checkoutsPerVisitor || page >= limits.checkoutsPerPage || mine >= limits.checkoutsPerOwner || platform + calls >= limits.keyCallsPlatform) return 'limit' as const;
    const made = await tx.appPageOrder.create({
      data: { jobId: terms.job.id, ownerId: terms.job.ownerId, connectionId: terms.connection.id, artifactId: terms.job.artifactId, definitionHash: terms.job.definitionHash, amountMinor: terms.job.amountMinor, currency: terms.job.currency, mode: terms.connection.keyMode, status: 'creating', visitorHash: hash },
    });
    return { order: made, ...terms };
  });
  if (started === 'gone') return { status: 'unavailable' };
  if (started === 'limit') return { status: 'limit' };
  const { order, job, connection, definition, payment } = started;

  const fail = async (status: 'not_paid' | 'cant_confirm') => {
    // Nobody was ever given a link for an order that fails here (the buyer is told "unavailable" and never learns its id), so nothing can be paid
    // against it: it is closed, and a try again makes a new order
    await prisma.appPageOrder.updateMany({ where: { id: order.id, status: 'creating' }, data: { status, ...(status === 'not_paid' ? { closedAt: new Date() } : {}) } }).catch(() => undefined);
    return { status: 'unavailable' } as const;
  };
  const { create } = payment;
  const operation = definition.operations.find((candidate) => candidate.id === create.operation);
  if (!operation) return fail('not_paid');
  // A key that cannot be read (damaged, or sealed with a key we no longer have) is a payment that cannot start: the order is closed, never left open
  let key: string;
  try {
    key = readKey(connection);
  } catch {
    return fail('not_paid');
  }
  const args: Record<string, unknown> = {
    [create.amount]: Number(minorToText(job.amountMinor, job.currency)),
    // The service's own spelling of the currency when it lists the ones it takes (a service may list "usd"; the job keeps "USD")
    [create.currency]: operation.params.find((param) => param.name === create.currency)?.oneOf?.find((allowed) => allowed.toUpperCase() === job.currency) ?? job.currency,
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
  const wording = wordsFor(operation, job.description);
  if (wording.value) args.description = wording.value;

  const startedAt = new Date();
  let answer;
  try {
    const built = buildRequest(definition, operation.id, args, key);
    answer = await guardedRequest({ ...built, timeoutMs: limits.keyCallSeconds * 1000, maxBytes: limits.keyAnswerKb * 1024 }, deps);
  } catch (error) {
    if (error instanceof RequestError || error instanceof GuardError) return fail('not_paid');
    // Anything else is ours to look at, but the order is not left open on the way out
    await fail('not_paid');
    throw error;
  }
  if (answer.redirected || answer.truncated) return fail('not_paid');
  if (answer.status === 401 || answer.status === 403) {
    await reportConnectionSignIn(connection.id, { state: 'expired', status: answer.status }, startedAt).catch(() => undefined);
    return fail('not_paid');
  }
  if (answer.status < 200 || answer.status >= 300) return fail('not_paid');
  // The service accepted the key: a "stopped working" mark from an earlier refusal (even one for another operation) no longer holds
  await reportKeyWorked(connection.id, connection.keyVersion, startedAt).catch(() => undefined);
  let picked: unknown;
  try {
    picked = pickFields(JSON.parse(answer.body), operation.returns);
  } catch {
    return fail('not_paid');
  }
  const providerRef = valueAt(picked, create.idPath);
  const where = valueAt(picked, create.checkoutUrlPath);
  const checkoutUrl = typeof where === 'string' ? safeCheckoutUrl(where, payment.checkoutHosts) : null;
  // An address that carries the key is never kept or given out, and never rewritten either (it may be signed): the checkout is not used
  if (checkoutUrl && carriesKey(checkoutUrl, key)) return fail('cant_confirm');
  if (typeof providerRef !== 'string' || !providerRef || providerRef.length > 255 || !checkoutUrl) return fail('cant_confirm');
  // Kept so a blocked pop-up can go on with the SAME order, and so a later look can find the payment
  // An order that was closed while the service was being asked (a sweep, the owner stopping the page) no longer holds: nothing could look
  // for its payment, so its address is not given out
  const kept = await prisma.appPageOrder.updateMany({ where: { id: order.id, status: 'creating' }, data: { status: 'pending', providerRef, checkoutUrl } });
  if (kept.count !== 1) return { status: 'unavailable' } as const;
  return { status: 'ok', orderId: order.id, checkoutUrl, amount: minorToText(job.amountMinor, job.currency), currency: job.currency, app: definition.short };
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
  testPayment: boolean;
}

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

const stateOf = (status: string): OrderState => (status === 'paid' ? 'paid' : status === 'not_paid' ? 'not_paid' : status === 'cant_confirm' ? 'cant_confirm' : 'checking');

/**
 * Asks the service about one order and moves it on. Safe to call as often as anyone likes (the visitor's page, the return page, the
 * service's notice): the service itself is asked at most once in `paymentCheckSeconds` (more for an order that has waited long) for an order, and "paid" is written once.
 */
export async function verifyOrder(orderId: string, deps: GuardDeps = {}): Promise<OrderView | null> {
  const order = await prisma.appPageOrder.findUnique({ where: { id: orderId }, include: { connection: true, job: { select: { artifact: { select: { title: true } } } } } });
  if (!order) return null;
  const view = (status: string, mode: string | null = order.mode): OrderView => ({ status: stateOf(status), checkoutUrl: status === 'pending' ? order.checkoutUrl : null, testPayment: mode === 'test' });
  const limits = await getBrickLimits();
  const now = new Date();
  // An order still being made, past the time the service had to answer, is one whose start never finished (the server stopped, or the answer
  // was lost): the buyer was never given a link for it, so nothing can have been paid against it. It ends as "could not confirm" and
  // stays that way, instead of being "checking" for ever.
  if (order.status === 'creating') {
    // A notice that comes while the start is still being made is asked to come back: it can be the only one the service sends
    if (now.getTime() - order.createdAt.getTime() <= limits.keyCallSeconds * 3 * 1000) return later(view('creating'));
    const ended = await prisma.appPageOrder.updateMany({ where: { id: order.id, status: 'creating' }, data: { status: 'cant_confirm' } });
    return view(ended.count === 1 ? 'cant_confirm' : order.status);
  }
  // Paid and cannot-confirm are final. A closed (not paid) order is asked about again for a while: the buyer may still pay at the service
  // after it was closed, and that is real money.
  if (order.status !== 'pending' && order.status !== 'not_paid') return view(order.status);
  const wasClosed = order.status === 'not_paid';
  // The late window runs from when the order was closed (an order closed because its time ran out closed at the end of that time)
  const closedAt = order.closedAt ?? new Date(order.createdAt.getTime() + limits.checkoutOpenHours * HOUR);
  if (wasClosed && now.getTime() - closedAt.getTime() > limits.latePaymentHours * HOUR) return nothingMoreToAsk(view(order.status));
  // What the order may still become: a pending one anything, a closed one only paid (or cannot-confirm for a payment that does not match)
  const open = { in: ['pending', 'not_paid'] };

  const connection = order.connection;
  const definition = connection && connection.kind === 'direct' ? definitionOf(connection) : null;
  // The app was disconnected: what it said could not be checked any more, and a payment is never assumed. A definition that changed since
  // the checkout began (a new key, a new catalog) is not a reason to give up on a payment that may be real: the look below uses the
  // definition now in force, and "paid" still needs the exact amount, currency, reference and mode.
  if (!connection || !definition?.payment || !order.providerRef) {
    if (wasClosed) return nothingMoreToAsk(view(order.status));
    await prisma.appPageOrder.updateMany({ where: { id: order.id, status: 'pending' }, data: { status: 'cant_confirm' } });
    return view('cant_confirm');
  }
  // A look the service never answered in a way we can read (an error, a refusal, an answer with no state) is asked again, as before. But an
  // order that has been open longer than its time allows, and still cannot be read, is closed like any other that ran out of time: the buyer's
  // page stops waiting, and a payment that turns out to be real is still found by the later looks (a closed order is asked about for a while).
  const unreadable = async (): Promise<OrderView> => {
    if (!wasClosed && now.getTime() - order.createdAt.getTime() > limits.checkoutOpenHours * HOUR) {
      const closed = await prisma.appPageOrder.updateMany({ where: { id: order.id, status: 'pending' }, data: { status: 'not_paid', closedAt: now } });
      if (closed.count === 1) return view('not_paid');
    }
    return later(view(order.status));
  };
  // One look per order in a few seconds, whoever is asking. The longer an order has been waiting the further apart its looks are (a minute
  // more adds one more `paymentCheckSeconds`, up to sixty of them): a buyer who pays is seen at once, while tabs left open on an order nobody
  // is paying cost an owner a small and shrinking share of their looks instead of the same share for the whole open time.
  const spacing = limits.paymentCheckSeconds * Math.min(60, 1 + Math.floor((now.getTime() - order.createdAt.getTime()) / 60_000));
  const taken = await prisma.appPageOrder.updateMany({
    where: { id: order.id, status: open, OR: [{ checkedAt: null }, { checkedAt: { lt: new Date(now.getTime() - spacing * 1000) } }] },
    data: { checkedAt: now, checks: { increment: 1 } },
  });
  if (taken.count === 0) return later(view(order.status));

  const { lookup } = definition.payment;
  let key: string;
  try {
    key = readKey(connection);
  } catch {
    // A key that cannot be read can never be used to ask again: a closed order stays as it is, an open one can no longer be confirmed
    if (wasClosed) return nothingMoreToAsk(view(order.status));
    await prisma.appPageOrder.updateMany({ where: { id: order.id, status: 'pending' }, data: { status: 'cant_confirm' } });
    return view('cant_confirm');
  }
  // Looks have a budget of their own, so that asking about payments can never use up what Bricks and checkouts may do with a key: what
  // everyone may send an hour, and what one owner's services may be asked. When either is spent the look waits for the next hour's room.
  const budget = await prisma
    .$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('key-calls:everyone', 0))`;
      const since = new Date(now.getTime() - HOUR);
      const [everyone, owners] = await Promise.all([
        tx.appKeyCall.count({ where: { ownerId: LOOKUP_ROWS, createdAt: { gte: since } } }),
        tx.appKeyCall.count({ where: { ownerId: LOOKUP_ROWS, callId: { startsWith: `look:${order.ownerId}:` }, createdAt: { gte: since } } }),
      ]);
      if (everyone >= limits.keyCallsPlatform || owners >= limits.paymentLooksPerOwner) return false;
      // Not counted for the owner's own hourly allowance (a buyer's page asks, not the owner)
      await tx.appKeyCall.create({ data: { connectionId: connection.id, ownerId: LOOKUP_ROWS, botId: LOOKUP_ROWS, callId: `look:${order.ownerId}:${order.id}:${order.checks + 1}`, operation: lookup.operation.slice(0, 60), state: 'done', outcome: 'ok' } });
      return true;
    })
    .catch(() => false);
  // No room for looks: it waits, but an order past its open time still ends (it is not left "checking" because looks ran short)
  if (!budget) return unreadable();
  const startedAt = new Date();
  let answer;
  try {
    const built = buildRequest(definition, lookup.operation, { [lookup.idParam]: order.providerRef }, key);
    answer = await guardedRequest({ ...built, timeoutMs: limits.keyCallSeconds * 1000, maxBytes: limits.keyAnswerKb * 1024 }, deps);
  } catch (error) {
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
    // Completed at the service, but not for what we asked: never counted as paid
    if (!same) {
      await prisma.appPageOrder.updateMany({ where: { id: order.id, status: open }, data: { status: 'cant_confirm' } });
      return view('cant_confirm');
    }
    const marked = await prisma.appPageOrder.updateMany({ where: { id: order.id, status: open }, data: { status: 'paid', paidAt: now } });
    if (marked.count === 1) await tellOwnerPaid(order, connection.name, definition.service !== 'custom', order.job?.artifact.title ?? 'your page', wasClosed);
    return view('paid');
  }
  // A closed order that the service still does not call completed stays closed
  if (wasClosed) return view('not_paid');
  // Only a state the service names as final closes an order early; anything else (started, authorised only, a state we never heard of) stays
  // open until it has been open too long. A payment that completes after that is still real money and is still counted above.
  const failed = typeof status === 'string' && lookup.failedStates.includes(status);
  if (!failed && !expired) return view('pending');
  const closed = await prisma.appPageOrder.updateMany({ where: { id: order.id, status: 'pending' }, data: { status: 'not_paid', closedAt: now } });
  return closed.count === 1 ? view('not_paid') : view('pending');
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

/** One order as the visitor's page may ask about it: only on the page it was made for. */
export async function orderForArtifact(orderId: string, artifactId: string, deps: GuardDeps = {}): Promise<OrderView | null> {
  const order = await prisma.appPageOrder.findUnique({ where: { id: orderId }, select: { artifactId: true } });
  if (!order || order.artifactId !== artifactId) return null;
  return verifyOrder(orderId, deps);
}

/** A page anyone with the link may open: the public page's checkout is only for it, and only while it is there. */
export async function isOpenByLink(artifactId: string): Promise<boolean> {
  const artifact = await prisma.artifact.findUnique({ where: { id: artifactId }, select: { openScope: true, expiresAt: true } });
  return !!artifact && artifact.openScope === 'link' && !(artifact.expiresAt && artifact.expiresAt.getTime() <= Date.now());
}

/** Whether a page is taking payments right now, for the page's own "Pay" button to know (nothing else about the job). */
export async function pageTakesPayments(artifactId: string): Promise<boolean> {
  const job = await prisma.appPageJob.findUnique({ where: { artifactId }, select: { status: true } });
  return job?.status === 'active';
}
