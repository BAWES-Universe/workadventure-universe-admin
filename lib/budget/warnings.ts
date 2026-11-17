import { prisma } from '@/lib/db';
import { addNotice } from '@/lib/notices';
import { isSuperAdmin } from '@/lib/super-admin';
import { monthOf } from '@/lib/meter-values';
import type { BudgetSettings } from '@/lib/budget/values';
import type { AccountView, AlertView, AreaView } from '@/lib/budget/types';

/**
 * The warnings (billing consensus v2, 3.4 and P6): a quiet line on the page at the first level, a notice in Orbit at the second and third with the
 * date it runs out and the sample it is based on, and a paused area named with its one remedy. The levels are the page's saved settings, never ours.
 * Raising (or a top up) makes a warning untrue, and a notice is made once for each budget amount and level in a month, so a raise gets fresh ones.
 */

const dollars = (micros: number) => `$${(micros / 1_000_000).toLocaleString('en', { minimumFractionDigits: micros % 1_000_000 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
const dayWords = (at: Date) => at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const percent = (value: number) => `${Math.floor(value)}%`;

/** An alert and, when it should also be told in Orbit, the notice that goes with it. */
export interface Warning {
  alert: AlertView;
  /** Told once in Orbit under this key, to every super admin. Absent for a quiet line. */
  notice?: { dedupe: string; title: string; body: string; href: string };
}

interface Unit {
  id: string;
  title: string;
  budget: number | null;
  used: number;
  runsOutAt: string | null;
  forecast: number;
  numberId: string | null;
  offer: number | null;
}

export function buildWarnings(areas: AreaView[], accounts: AccountView[], settings: Pick<BudgetSettings, 'warnFirstPercent' | 'warnSecondPercent' | 'warnThirdPercent'>): Warning[] {
  const out: Warning[] = [];
  for (const area of areas) {
    if (area.key === 'chat') continue;
    const reading = area.reading ? { sampleDays: area.reading.sampleDays, readAt: area.reading.readAt, sparse: area.reading.sparse, burst: area.reading.burst } : null;
    const units: Unit[] = [];
    if (area.lines) {
      for (const line of area.lines) {
        units.push({ id: `${area.key}:${line.key}`, title: `${line.title} (Apps)`, budget: line.budgetMicros, used: line.spentMicros + line.heldMicros, runsOutAt: null, forecast: line.spentMicros + line.heldMicros, numberId: line.numberId, offer: null });
      }
    } else {
      const used = area.budgetMicros !== null && area.usedPercent !== null ? (area.usedPercent / 100) * area.budgetMicros : area.spentMicros + area.heldMicros;
      units.push({ id: area.key, title: area.title, budget: area.budgetMicros, used, runsOutAt: area.runsOutAt, forecast: area.forecastMicros, numberId: area.numberId, offer: area.offers[0]?.micros ?? null });
    }
    for (const unit of units) {
      if (unit.budget === null || !unit.numberId) continue;
      const used = unit.budget > 0 ? (unit.used / unit.budget) * 100 : 100;
      const href = `/admin/ai-providers/budget?raise=${encodeURIComponent(unit.numberId)}`;
      const raise = { area: area.key, numberId: unit.numberId, toMicros: unit.offer };
      const key = `${unit.id}:${unit.budget}`;
      if (used >= 100) {
        // A provider's missing money is the remedy when that is why the area is paused: raising a budget would not help
        if (area.state === 'provider') continue;
        const body = area.ifPaused ? `${area.ifPaused.stops} ${area.ifPaused.stillCosts}` : 'New funded work in this area waits until you raise it or the month turns.';
        out.push({
          alert: { key: `${unit.id}:reached`, level: 'paused', title: `${unit.title} budget reached`, body, raise },
          notice: { dedupe: `reached:${key}`, title: `${unit.title} budget reached`, body: `${body} Tap to raise it.`, href },
        });
        continue;
      }
      const { warnFirstPercent: first, warnSecondPercent: second, warnThirdPercent: third } = settings;
      const day = unit.runsOutAt ? new Date(unit.runsOutAt) : null;
      const level = third !== null && used >= third ? 'third' : second !== null && used >= second ? 'second' : null;
      if (level || (day && area.state === 'low')) {
        const title = `${unit.title} is at ${percent(used)}${day ? ` and runs out about ${dayWords(day)}` : ''}`;
        const body = `At this pace the month needs about ${dollars(unit.forecast)}. The budget is ${dollars(unit.budget)}.`;
        out.push({
          alert: { key: `${unit.id}:notice`, level: 'notice', title, body, raise, reading },
          notice: { dedupe: `${level ?? 'pace'}:${key}`, title, body: `${body} Tap to raise it.`, href },
        });
      } else if (first !== null && used >= first) {
        out.push({ alert: { key: `${unit.id}:quiet`, level: 'quiet', title: `${unit.title} has used ${percent(used)} of its budget`, body: `${dollars(unit.budget)} for the month.`, reading } });
      }
    }
    if (area.state === 'capacity') {
      const waiting = area.facts.find((fact) => fact.includes('waiting')) ?? 'Jobs are waiting.';
      out.push({ alert: { key: `${area.key}:capacity`, level: 'paused', title: 'Computers are full, money is fine', body: `${waiting}. Raising the budget won’t help. Wait, or let more run at once.`, capacity: true } });
    }
  }
  for (const account of accounts) {
    if (account.state !== 'zero' && account.state !== 'low') continue;
    const empty = account.state === 'zero';
    const title = empty ? `${account.name} is empty` : `${account.name} is running low`;
    const body = empty
      ? `${account.paysFor} is paused. This is money at ${account.name}, so raising a budget won’t help. After you top up, Orbit checks the balance and carries on with each waiting job once.`
      : `${account.line} This is the account at ${account.name}, not a Universe budget.`;
    out.push({
      alert: { key: `account:${account.key}:${account.state}`, level: empty ? 'paused' : 'notice', title, body, topUp: { name: account.name, url: account.url } },
      notice: { dedupe: `account:${account.key}:${account.state}`, title, body, href: '/admin/ai-providers/budget' },
    });
  }
  return out;
}

/** Every super admin who has an account here: the people the notices go to. */
async function superAdminIds(): Promise<string[]> {
  const emails = (process.env.SUPER_ADMINS ?? '')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
  if (emails.length === 0) return [];
  const users = await prisma.user.findMany({ where: { OR: emails.map((email) => ({ email: { equals: email, mode: 'insensitive' as const } })) }, select: { id: true, email: true } });
  return users.filter((user) => isSuperAdmin(user.email)).map((user) => user.id);
}

/** Tells every super admin once about each warning that needs a notice, under a key that holds the month, the budget and the level. Returns how many were new. */
export async function sendNotices(warnings: Warning[], now: Date = new Date()): Promise<number> {
  const withNotice = warnings.filter((warning) => warning.notice);
  if (withNotice.length === 0) return 0;
  const month = monthOf(now).start.toISOString().slice(0, 7);
  const admins = await superAdminIds();
  let made = 0;
  for (const userId of admins) {
    for (const warning of withNotice) {
      const notice = warning.notice!;
      if (await addNotice({ userId, kind: 'budget', dedupeKey: `budget:${month}:${notice.dedupe}`, title: notice.title, body: notice.body, href: notice.href })) made += 1;
    }
  }
  return made;
}

/** A warning stopped being true (the budget was raised, or a company was topped up): its notices are cleared for everyone, so nobody is told a thing that is not so. */
export async function clearBudgetNotices(dedupePart: string): Promise<void> {
  await prisma.userNotice.updateMany({ where: { kind: 'budget', dedupeKey: { contains: dedupePart }, dismissedAt: null }, data: { dismissedAt: new Date() } });
}
