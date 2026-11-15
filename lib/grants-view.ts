/**
 * The grants screens' words and shapes (spec v3 sections 2, 7a and 11), with no database in them: the Grants page, its sheets and
 * the routes under /api/admin/grants all read the same ones. Money is kept in millionths of a dollar, as the books keep it; a
 * screen shows dollars. Nothing here is a price or an amount of ours: every figure comes from what a super admin types or from the
 * server's preview. No gateway is named anywhere: a gift never needs one.
 */

export type MoneyCategory = 'instant_apps' | 'computers';
export const MONEY_CATEGORIES: readonly MoneyCategory[] = ['instant_apps', 'computers'];
export const CATEGORY_NAME: Record<MoneyCategory | 'universe_ai', string> = { universe_ai: 'Universe AI', instant_apps: 'Instant Apps', computers: 'Computers' };

/** How often a default or an exception gives: once (when the account starts, or once for existing people), every month (the 1st, UTC) or never. */
export type Interval = 'once' | 'monthly' | 'none';

/** Who a grant is for. No universe roles: roles belong to each universe, and "people you pick" covers staff and anyone special. */
export type Recipients =
  | { kind: 'all' }
  | { kind: 'new_from'; from: string; to?: string }
  | { kind: 'people'; userIds: string[] }
  | { kind: 'universe'; universeId: string; mode?: 'snapshot' | 'changing' };

export interface PersonView {
  id: string;
  name: string;
  woka: string[];
}

/** A group a standing rule or a gift is for: people picked one by one, or a universe's members. */
export interface AudienceView {
  kind: 'people' | 'universe';
  people: PersonView[];
  universe: { id: string; name: string } | null;
  /** How many people it reaches now. */
  count: number;
}

export type ExceptionSetting = { mode: 'same' } | { mode: 'none' } | { mode: 'own'; amountMicros: number; interval: 'once' | 'monthly' };

export interface MoneyDefaultView {
  set: boolean;
  amountMicros: number | null;
  interval: Interval;
  recipients: Recipients | null;
}

export interface ExceptionView {
  id: string;
  audience: AudienceView;
  instant_apps: ExceptionSetting;
  computers: ExceptionSetting;
}

export type GiftScope = 'apps' | 'computers' | 'both';

export interface GiftView {
  id: string;
  audience: AudienceView;
  /** Each person's amount, or the shared total. */
  amountMicros: number;
  shared: boolean;
  /** The most it issues: the amount for everyone, or the shared total. */
  totalMicros: number;
  scope: GiftScope;
  endsAt: string;
  ended: boolean;
  usedMicros: number;
  givenByName: string;
  settlement: 'gift' | 'to_bill';
  billedAt: string | null;
  /** Who pays, in the words people see: "Paid by Universe". */
  payer: string;
}

export interface GrantsOverview {
  ai: { signedIn: number; guest: number; windowHours: number };
  money: Record<MoneyCategory, MoneyDefaultView>;
  exceptions: ExceptionView[];
  gifts: GiftView[];
  /** What Universe has promised this month against the rollout budget (null until that is set), and what has been used. */
  totals: { people: number; issuedMonthMicros: number; usedMonthMicros: number; budgetMicros: number | null };
}

/** What a preview request asks about. The server answers with `PreviewView`, and a clash is also checked again when saving. */
export type PreviewRequest =
  | { what: 'default'; category: MoneyCategory; amountMicros: number | null; interval: Interval; recipients: Recipients; startsOn?: 'next' | 'now' }
  | { what: 'exception'; audience: Recipients; instant_apps: ExceptionSetting; computers: ExceptionSetting; replaceId?: string }
  | { what: 'gift'; audience: Recipients; scope: GiftScope; amountMicros: number; shared: boolean; endsAt: string; /** A changing universe: the most people who can join before the end. */ joinerCap?: number };

/** The numbers behind the three parts of a preview (spec 7a), never one "most it can cost" number. */
export interface PreviewNumbers {
  /** How many people qualify now, and how many of them have their own rule. */
  people: number;
  ownRules: number;
  /** Also reaches people who qualify later (new accounts, a changing group). */
  laterToo: boolean;
  /** What each one gets, or the shared total. */
  amountMicros: number;
  interval: Interval;
  shared: boolean;
  startsOn?: 'next' | 'now';
  /** The most credit issued to the people there are now (per month for a monthly rule); null when it is not a money figure. */
  mostNowMicros: number | null;
  /** What saving issues straight away to the people there now (the funding check). Never more than the most it can issue. */
  issuedNowMicros?: number | null;
  /** True when nothing caps how long or how many it reaches, so there is no lifetime maximum. */
  noLifetimeMax: boolean;
  endsOn?: string;
  /** Who it would be for, said in names ("Omar, Noor and 2 others"), for lines that need them. */
  audienceName?: string;
  /** Lines about credit the same people already have, such as "Omar already has $10 a month from an exception." */
  already: string[];
  /** The funding account's room this month: null budget means nothing is issued until the rollout budget is set in Limits. */
  budget: { budgetMicros: number | null; roomMicros: number };
}

export interface ClashView {
  /** The people the two rules disagree for. */
  people: string[];
  other: { name: string; text: string };
  /** This rule, said as the choice offers it. */
  thisText: string;
}

export interface PreviewView {
  numbers: PreviewNumbers | null;
  clash: ClashView | null;
  /** The server refused to work it out (a wrong amount, a missing group): the line to show instead of a preview. */
  problem?: string;
}

/** A piece of a preview sentence: plain, or bold (the figures people check). */
export type Seg = string | { b: string };
export type PreviewRow = [label: string, text: Seg[]];

export const usd = (micros: number): string => {
  const dollars = micros / 1_000_000;
  const whole = Number.isInteger(dollars);
  return `$${dollars.toLocaleString('en', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
};

/** Dollars typed by a person, to millionths: null for anything that is not a positive amount, so nothing is guessed. */
export function microsOfDollars(text: string): number | null {
  const cleaned = text.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,6})?$/.test(cleaned)) return null;
  const micros = Math.round(Number(cleaned) * 1_000_000);
  return micros > 0 && Number.isSafeInteger(micros) ? micros : null;
}

/** The amount as typed into a box: "5" or "2.5", from millionths. */
export const dollarsText = (micros: number | null): string => (micros === null ? '' : String(micros / 1_000_000));

export const nameList = (names: string[], max = 3): string => {
  if (names.length <= max) return new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' }).format(names);
  const rest = names.length - (max - 1);
  return `${names.slice(0, max - 1).join(', ')} and ${rest} others`;
};

const plural = (value: number, one: string, many: string) => `${value.toLocaleString('en')} ${value === 1 ? one : many}`;

/** "Instant Apps $10 once", "Computers $5 a month": one default or one exception setting, said in a few words. */
export function amountLine(category: MoneyCategory, amountMicros: number, interval: 'once' | 'monthly'): string {
  return `${CATEGORY_NAME[category]} ${usd(amountMicros)} ${interval === 'once' ? 'once' : 'a month'}`;
}

/** A default's line on the Grants page. Unset says what that means: nobody gets it yet, or computer jobs are refused. */
export function defaultLines(category: MoneyCategory, view: MoneyDefaultView): string[] {
  if (!view.set) return ['Not set', category === 'computers' ? 'Computer jobs are refused until you set it' : 'Nobody gets Instant Apps credit yet'];
  if (view.interval === 'none' || view.amountMicros === null) return ['No credit from the default', 'Exceptions and gifts still work'];
  const how = view.interval === 'once' ? `${usd(view.amountMicros)} once, when someone joins` : `${usd(view.amountMicros)} a month, renews on the 1st`;
  return [how, recipientsLine(view.recipients)];
}

export function recipientsLine(recipients: Recipients | null): string {
  if (!recipients) return 'All signed-in members';
  switch (recipients.kind) {
    case 'all':
      return 'All signed-in members';
    case 'new_from':
      return `New people from ${new Date(recipients.from).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`;
    case 'people':
      return 'People you picked';
    case 'universe':
      return 'A universe’s members';
  }
}

export function audienceTitle(audience: AudienceView): string {
  if (audience.kind === 'universe') return audience.universe?.name ?? 'A universe';
  return nameList(audience.people.map((person) => person.name), 4) || 'Nobody picked';
}

export function exceptionLines(exception: ExceptionView): string[] {
  const parts: string[] = [];
  for (const category of MONEY_CATEGORIES) {
    const setting = exception[category];
    if (setting.mode === 'own') parts.push(amountLine(category, setting.amountMicros, setting.interval));
    else if (setting.mode === 'none') parts.push(`${CATEGORY_NAME[category]}: no grant`);
  }
  const who = exception.audience.kind === 'universe' ? ['Its members', plural(exception.audience.count, 'person', 'people') + ' now'] : [exception.audience.people.length === 1 ? 'Their own rule comes first' : 'People you picked'];
  return [...who, ...parts];
}

export function giftLines(gift: GiftView): string[] {
  const scope = gift.scope === 'both' ? 'Instant Apps and computers' : gift.scope === 'apps' ? 'Instant Apps' : 'Computers';
  const amount = gift.shared ? `${usd(gift.amountMicros)} shared in total` : `${usd(gift.amountMicros)} each, ${usd(gift.totalMicros)} in total`;
  return [amount, scope, `${gift.ended ? 'ended' : 'until'} ${new Date(gift.endsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`];
}

export function giftMeta(gift: GiftView): string[] {
  return [`${usd(gift.usedMicros)} used so far`, `given by ${gift.givenByName}`, gift.payer];
}

export const giftPill = (gift: Pick<GiftView, 'settlement' | 'billedAt'>): string => (gift.settlement === 'gift' ? 'A gift' : gift.billedAt ? 'Billed' : 'To bill');

/**
 * The three-part preview of a default, an exception or a gift (spec 7a), in words, from the server's numbers. "Who gets what",
 * "Most credit issued" and "What it can cost us" are three different numbers and stay three rows. A dollar of credit is not a dollar
 * of provider cost, and a group with nothing capping it says plainly that there is no lifetime maximum.
 */
export function previewRows(request: PreviewRequest, numbers: PreviewNumbers | null): PreviewRow[] {
  if (request.what === 'default' && request.interval === 'none') {
    return [['Who gets what', ['Nobody gets ' + CATEGORY_NAME[request.category] + ' credit from the default. Exceptions and gifts still apply. Credit already given stays until it’s used or ends.']]];
  }
  if (!numbers) return [['Who gets what', ['Type an amount to see who gets it and what it can cost.']]];
  const n = numbers;
  const amount = usd(n.amountMicros);
  const cost: PreviewRow = ['What it can cost us', ['At provider prices, up to what’s used. A dollar of credit is not a dollar of provider cost. Live on Costs.']];
  const rows: PreviewRow[] = [];
  if (request.what === 'default') {
    const own = n.ownRules > 0 ? ` (${plural(n.ownRules, 'person has', 'people have')} their own rules)` : '';
    if (request.interval === 'once') {
      rows.push(['Who gets what', [{ b: plural(n.people, 'person', 'people') }, ` get ${amount} once, now${own}.`, ...(n.laterToo ? [` Each person who qualifies later gets ${amount} once.`] : [])]]);
      rows.push([
        'Most credit issued',
        n.noLifetimeMax
          ? [{ b: usd(n.mostNowMicros ?? 0) }, ` now, plus ${amount} for each new account. No end date, so there is no lifetime maximum. The sign-up limit in Limits caps how fast it grows.`]
          : [{ b: usd(n.mostNowMicros ?? 0) }, ' in total.'],
      ]);
    } else {
      rows.push(['Who gets what', [{ b: plural(n.people, 'person', 'people') }, ` get ${amount} ${n.startsOn === 'now' ? 'now for the rest of this month, then every month' : 'a month from the 1st'}${own}. What’s left doesn’t carry over.`]]);
      rows.push(['Most credit issued', ['Up to ', { b: `${usd(n.mostNowMicros ?? 0)} a month` }, ` for these people${n.laterToo ? `, plus ${amount} a month for each new member` : ''}.`]]);
    }
    rows.push(cost);
    const funding = fundingRow(n);
    if (funding) rows.push(funding);
    return rows;
  }
  if (request.what === 'exception') {
    rows.push(['Who gets what', [{ b: plural(n.people, 'person', 'people') }, ' get their own rule in place of the defaults. Someone taken off goes back to the defaults at the next renewal. Credit already given stays.']]);
    rows.push(['Most credit issued', n.mostNowMicros === null ? ['No credit from this rule.'] : ['Up to ', { b: `${usd(n.mostNowMicros)} a month` }, n.laterToo ? '. A universe’s members change, so it grows when people join.' : '. It only grows if you add people.']]);
    rows.push(cost);
    const funding = fundingRow(n);
    if (funding) rows.push(funding);
    return rows;
  }
  // A gift
  const total = n.mostNowMicros ?? 0;
  const only = n.laterToo ? 'The people there are now, and those who join before it ends (up to the most you set).' : `Only ${n.people === 1 ? 'this person' : `these ${n.people}`}, even if more people are added somewhere later.`;
  rows.push([
    'Who gets what',
    n.shared
      ? [n.people === 1 ? 'This person has ' : `The ${n.people} share `, { b: `one ${amount}` }, ` for ${scopeWords(request.scope)}. Whoever uses it first uses it. Two people can never spend the same dollar at once.`]
      : [n.people === 1 ? 'This person gets ' : `Each of the ${n.people} gets `, { b: `one ${amount}` }, ` for ${scopeWords(request.scope)}${request.scope === 'both' ? `, not ${amount} for each` : ''}. ${only}`],
  ]);
  rows.push(['Most credit issued', [{ b: `${usd(total)} in total` }, n.endsOn ? `, ending ${n.endsOn}. Used before their own credit, because it ends sooner.` : '.']]);
  rows.push(cost);
  const funding = fundingRow(n);
  if (funding) rows.push(funding);
  for (const line of n.already) rows.push(['Already has', [line]]);
  return rows;
}

/** The funding line: nothing is given out until the rollout budget is set, and a rule bigger than what is left this month is refused on save. */
function fundingRow(n: PreviewNumbers): PreviewRow | null {
  if (n.budget.budgetMicros === null) return ['Funding', ['Nothing is given out until you set the rollout budget in Limits.']];
  const first = n.interval === 'none' ? 0 : n.issuedNowMicros ?? n.mostNowMicros ?? 0;
  if (first > n.budget.roomMicros) return ['Funding', [`This is more than the ${usd(n.budget.roomMicros)} left in this month’s rollout budget. Raise the budget in Limits first.`]];
  return null;
}

const scopeWords = (scope: GiftScope) => (scope === 'both' ? 'Instant Apps or computers' : scope === 'apps' ? 'Instant Apps' : 'computers');

/** A clash is said with the names it is about, then asks which rule applies. */
export function clashLine(clash: ClashView): Seg[] {
  return [{ b: nameList(clash.people, 3) }, ` ${clash.people.length === 1 ? 'is' : 'are'} also covered by ${clash.other.name}, whose rule gives ${clash.other.text}. Choose which rule applies to them before saving.`];
}

/** The Universe AI sheet's preview. Replies, not dollars: what each costs us depends on the model and how long the answers are. */
export function aiPreviewRows(signedIn: number, guest: number, windowHours: number): PreviewRow[] {
  return [
    ['Who gets what', ['All signed-in members: ', { b: plural(signedIn, 'reply', 'replies') }, ` every ${plural(windowHours, 'hour', 'hours')}. Guests: ${guest.toLocaleString('en')}. Exceptions and 2x or 5x extras still apply.`]],
    ['When it changes', ['From each person’s next window. Nobody’s current window resets, and replies already used stay used.']],
    ['What it can cost us', ['Replies, not dollars: the cost depends on the AI model and how long the answers are. Live on Costs.']],
  ];
}
