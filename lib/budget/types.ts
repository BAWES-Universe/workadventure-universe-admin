import type { AreaKey, AppsLine, NumberGroup, NumberUnit } from '@/lib/budget/numbers';

/** What GET /api/admin/budget answers. Money is in millionths of a dollar; the page turns it into dollars. */
export type AreaState = 'ok' | 'low' | 'reached' | 'provider' | 'capacity' | 'not_set';

export interface Offer {
  micros: number;
  words: string;
}

export interface NumberView {
  id: string;
  label: string;
  hint: string;
  unit: NumberUnit;
  group: NumberGroup;
  area: AreaKey | null;
  /** Null: nothing is saved ("Not set"). */
  value: number | null;
  range: { min: number; max: number };
  lastChange: { by: string | null; at: string } | null;
}

export interface LineView {
  key: AppsLine;
  title: string;
  budgetMicros: number | null;
  spentMicros: number;
  heldMicros: number;
  facts: string[];
  numberId: string | null;
}

export interface AreaView {
  key: AreaKey;
  title: string;
  covers: string;
  /** Null for chat: not controlled by a budget. */
  budgetMicros: number | null;
  spentMicros: number;
  heldMicros: number;
  forecastMicros: number;
  runsOutAt: string | null;
  usedPercent: number | null;
  state: AreaState;
  stateLine: string;
  facts: string[];
  lines?: LineView[];
  flag?: string;
  ifPaused?: { stops: string; stillCosts: string };
  offers: Offer[];
  /** The number a raise saves, when the area has one (an Apps line has its own). */
  numberId: string | null;
  /** A money problem at a company, not a Universe budget: the page offers a top up first. */
  topUp?: { name: string; url: string };
  capacity?: boolean;
  tidy?: boolean;
  /** How the forecast was read. */
  reading: { sampleDays: number; daysWithUse: number; readAt: string; sparse: boolean; burst: boolean } | null;
  /** The cost of unpriced use, unknown rather than zero. */
  unpricedEvents: number;
}

export interface AlertView {
  key: string;
  level: 'quiet' | 'notice' | 'paused';
  title: string;
  body: string;
  basis?: string;
  /** Raise opens the sheet on this number; `toMicros` is the first suggestion, when there is one. */
  raise?: { area: AreaKey; numberId: string; toMicros: number | null };
  topUp?: { name: string; url: string };
  capacity?: boolean;
  /** What the notice is based on, for the line under it: the days read and when. */
  reading?: { sampleDays: number; readAt: string; sparse: boolean; burst: boolean } | null;
}

export type AccountKind = 'balance' | 'plan' | 'after' | 'unknown';
export type AccountState = 'ok' | 'low' | 'zero' | 'unknown' | 'error';

export interface AccountView {
  key: string;
  name: string;
  paysFor: string;
  kind: AccountKind;
  /** The balance in millionths of a dollar, for a company that gives one. */
  balanceMicros: number | null;
  /** For a plan: how much of the included amount is left, 0 to 100. */
  planLeftPercent: number | null;
  planRenewsAt: string | null;
  state: AccountState;
  line: string;
  /** "Checked" when the company told us, "Our count" when it is ours. */
  checkedAt: string | null;
  checkedBy: 'company' | 'ours' | null;
  url: string;
  /** Days left at this pace and what would last thirty days, when both are known. */
  daysLeft: number | null;
  thirtyDayMicros: number | null;
  /** Whether "I topped up, check again" does anything for this one. */
  canVerify: boolean;
  /** What else the company tells us, one short line each: auto refill, the free part, invoices, the plan saved here, our own count. */
  facts: string[];
  /** The company says the account is overdrawn or a payment failed: shown in red. */
  overdue: boolean;
  /** For a company read with a key of its own (Soniox): whether that key is saved. Absent when no extra key is needed. */
  connection?: { connected: boolean; what: string };
  /** Orbit can ask the company for a payment link (Agent37). */
  addFunds: boolean;
}

export interface AskView {
  personId: string;
  name: string;
  woka: string[];
  area: string;
  what: string;
  askedAt: string;
}

export interface ChangeView {
  id: string;
  numberId: string;
  label: string;
  unit: NumberUnit;
  oldValue: number | null;
  newValue: number | null;
  by: string;
  at: string;
  note: string | null;
}

export interface BudgetReport {
  readAt: string;
  monthTurns: string;
  covers: string;
  basis: string;
  total: { budgetMicros: number; spentMicros: number; heldMicros: number; forecastMicros: number; platformMicros: number; unsetAreas: AreaKey[] };
  alerts: AlertView[];
  areas: AreaView[];
  accounts: AccountView[];
  numbers: NumberView[];
  changes: ChangeView[];
  asks: AskView[];
  /** Gross cost this month and what members fund themselves, apart. */
  funding: { grossMicros: number; paidByMembersMicros: number; perTask: { label: string; micros: number; count: number }[] };
}
