/**
 * What a bot reply cost (game #1173). The bot server works the cost out and sends it; Orbit keeps it and tells the story
 * of how it got there. These are the rules for reading what it sends and for adding rows up, free of server code so
 * the routes and the pages agree.
 *
 * A row is one of: priced / provider / override (a number of millionths of a dollar), own_computer (a real zero),
 * unknown (no number: nobody knows the price), or an old estimate (made before this, kept in the old `cost` column).
 */

export const COST_BASES = ['priced', 'provider', 'override', 'own_computer', 'unknown'] as const;
export type CostBasis = (typeof COST_BASES)[number];

/** Millionths of a dollar a single row may hold (the column is a 32-bit integer): about $2,000, far above any one reply. */
const MAX_MICROS = 2_000_000_000;
/** Token counts are 32-bit integers in the database too. */
const MAX_TOKENS = 2_000_000_000;

/** The columns a usage row gets for its price facts. Every key is present so a create call never leaves one out by accident. */
export interface UsagePriceFacts {
  inputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costMicros: number | null;
  costBasis: CostBasis | null;
  priceSource: string | null;
  priceVersion: string | null;
}

function wholeNumber(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.round(value), max);
}

function shortText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

/**
 * Reads the price facts out of what the bot server sent. A body without a `costBasis` is a bot server from before this
 * (it sent only the old `cost`), and its row stays an old estimate: no facts are taken from it.
 * A basis that is not known is dropped with the rest, and the number is only kept when the basis says there is one
 * (an `unknown` price never carries a number, and every other basis must).
 */
export function readUsagePriceFacts(body: Record<string, unknown>): UsagePriceFacts | null {
  const basis = COST_BASES.find((candidate) => candidate === body.costBasis);
  if (!basis) return null;
  const micros = wholeNumber(body.costMicros, MAX_MICROS);
  if (basis !== 'unknown' && micros === null) return null;
  return {
    inputTokens: wholeNumber(body.inputTokens, MAX_TOKENS),
    cachedTokens: wholeNumber(body.cachedTokens, MAX_TOKENS),
    cacheWriteTokens: wholeNumber(body.cacheWriteTokens, MAX_TOKENS),
    outputTokens: wholeNumber(body.outputTokens, MAX_TOKENS),
    reasoningTokens: wholeNumber(body.reasoningTokens, MAX_TOKENS),
    costMicros: basis === 'unknown' ? null : micros,
    costBasis: basis,
    priceSource: shortText(body.priceSource, 60),
    priceVersion: shortText(body.priceVersion, 60),
  };
}

/** What a set of rows cost, kept in three parts so the old estimates and the new figures are never added together. */
export interface CostTotals {
  /** Dollars from rows that have a real price (including real zeros). */
  cost: number;
  /** Dollars from rows made before price facts existed. A flat-rate guess, shown apart. */
  oldEstimateCost: number;
  /** How many calls could not be priced. They add nothing to `cost`. */
  unknownCalls: number;
}

export function emptyCostTotals(): CostTotals {
  return { cost: 0, oldEstimateCost: 0, unknownCalls: 0 };
}

interface CostRow {
  apiCalls: number;
  cost: unknown;
  costMicros: number | null;
  costBasis: string | null;
}

/** Adds one row in. Money is added as whole millionths so many tiny replies do not drift. */
export function addCostRow(totals: CostTotals, row: CostRow): void {
  if (row.costMicros !== null && row.costMicros !== undefined) {
    totals.cost = (Math.round(totals.cost * 1e6) + row.costMicros) / 1e6;
  } else if (row.costBasis === 'unknown') {
    totals.unknownCalls += row.apiCalls;
  } else if (row.cost !== null && row.cost !== undefined) {
    totals.oldEstimateCost = (Math.round(totals.oldEstimateCost * 1e6) + Math.round(Number(row.cost) * 1e6)) / 1e6;
  }
}

/** Dollars for the pages: two decimals normally, more when the amount is small enough that two would round it away. */
export function formatUsd(amount: number): string {
  const digits = amount === 0 || Math.abs(amount) >= 0.01 ? 2 : Math.abs(amount) >= 0.0001 ? 4 : 6;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: digits }).format(amount);
}
