import type { CostsReport, GivenRow } from '@/lib/meter-costs';

/** The plain words of the Costs page and the person's page: the same sentence in both, written once. */

const plural = (value: number, one: string, many: string) => `${value.toLocaleString('en')} ${value === 1 ? one : many}`;

/** The longest range one Costs request may ask for, so the page never builds a year of figures by accident (the page and the route share it). */
export const COSTS_MAX_DAYS = 366;

export const dollars = (micros: number): string => {
  const amount = micros / 1_000_000;
  // Small amounts keep their cents ($0.31); a cost under a cent is "less than a cent" rather than a lie of $0.00
  if (amount > 0 && amount < 0.005) return '<$0.01';
  return new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' }).format(amount);
};

export const day = (iso: string): string => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** "9 hours of computer", "40 minutes of computer", or nothing when it did not run. */
export function computerTime(seconds: number): string | null {
  if (seconds <= 0) return null;
  if (seconds >= 3600) return `${plural(Math.round(seconds / 3600), 'hour', 'hours')} of computer`;
  return `${plural(Math.max(1, Math.round(seconds / 60)), 'minute', 'minutes')} of computer`;
}

/** "264 replies · 96 app uses · 26 hours of computer": what a person or a Brick did, only what it did. */
export function didLine(item: { replies: number; appUses: number; computerSeconds: number; ownKeyReplies?: number }): string[] {
  return [item.replies > 0 && plural(item.replies, 'reply', 'replies'), item.appUses > 0 && plural(item.appUses, 'app use', 'app uses'), computerTime(item.computerSeconds)].filter((part): part is string => !!part);
}

/** "Twice the usual", "5 times the usual" or "No limit". */
export function amountWords(item: { multiplier: number | null; noLimit: boolean }): string {
  if (item.noLimit || item.multiplier === null) return 'No limit';
  return item.multiplier === 2 ? 'Twice the usual' : `${item.multiplier} times the usual`;
}

/** The pill on a given row: "To bill" until it is marked billed, "Billed" after, and "A gift" for a gift. */
export function givenPill(item: Pick<GivenRow, 'settlement' | 'billedAt'>): string {
  if (item.settlement === 'gift') return 'A gift';
  return item.billedAt ? 'Billed' : 'To bill';
}

/** "10 Nov to 30 Nov" and ", ended" once it has. */
export function givenDates(item: Pick<GivenRow, 'startsAt' | 'endsAt' | 'ended'>): string {
  return `${day(item.startsAt)} to ${day(item.endsAt)}${item.ended ? ', ended' : ''}`;
}

/** What the "Our count and theirs" row says beside its pill. */
export function goesLines(row: CostsReport['goes'][number]): string[] {
  if (row.key === 'files') {
    const gb = (row.bytes ?? 0) / 1_000_000_000;
    const size = gb >= 0.1 ? `${gb.toFixed(1)} GB kept` : (row.bytes ?? 0) > 0 ? 'Under 0.1 GB kept' : 'Nothing kept yet';
    return [size, row.ourMicros === null ? 'no price set yet' : `Our count ${dollars(row.ourMicros)} a month`];
  }
  if (row.key === 'apps') {
    const uses = plural(row.uses ?? 0, 'use', 'uses');
    return [uses, row.ourMicros === null ? 'no price known yet' : `Our count ${dollars(row.ourMicros)}`];
  }
  if (row.ourMicros === null) return ['Our count not known yet', row.unpriced > 0 ? `${plural(row.unpriced, 'use has', 'uses have')} no price yet` : ''].filter(Boolean);
  const lines = [`Our count ${dollars(row.ourMicros)}`];
  if (row.settledMicros !== null) lines.push(`settled by the provider ${dollars(row.settledMicros)}`);
  if (row.unpriced > 0) lines.push(`${plural(row.unpriced, 'use has', 'uses have')} no price yet`);
  return lines;
}
