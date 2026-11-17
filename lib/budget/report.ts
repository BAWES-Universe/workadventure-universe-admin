import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { Agent37Client } from '@/lib/agent37/client';
import { getInstantPause } from '@/lib/instant/state';
import { monthOf } from '@/lib/meter-values';
import { openRequests } from '@/lib/meter-requests';
import { wokaLayersForMany } from '@/lib/woka-avatar';
import { buildAreas } from '@/lib/budget/areas';
import { paceFor, readAccounts, type FetchLike, type Stored } from '@/lib/budget/accounts';
import { listChanges, lastChanges } from '@/lib/budget/history';
import { monthSum } from '@/lib/budget/books';
import { NUMBER_DEFS, available, rangeOf, readValues, valueOf, numberById, type Values } from '@/lib/budget/numbers';
import { buildWarnings, sendNotices, type Warning } from '@/lib/budget/warnings';
import type { AccountView, AreaView, AskView, BudgetReport, ChangeView, NumberView } from '@/lib/budget/types';

/**
 * The whole Budget page as one answer (GET /api/admin/budget): the header, the five areas, the warnings, the company accounts, every number with its
 * range and who last changed it, the change history, who asked for more, and gross cost beside what members fund themselves. It reads; the only
 * thing it writes is the last good reading of each company (so a company that is down for a while still shows its last reading and its time) and the
 * notices a warning calls for.
 */

const ACCOUNTS_KEY = 'budget-accounts';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

async function storedAccounts(): Promise<Stored> {
  const row = await prisma.appSetting.findUnique({ where: { key: ACCOUNTS_KEY } });
  return isRecord(row?.value) ? (row.value as unknown as Stored) : {};
}

async function saveAccounts(previous: Stored, fresh: Stored, userId: string | null): Promise<void> {
  if (Object.keys(fresh).length === 0) return;
  const value = { ...previous, ...fresh } as unknown as Prisma.InputJsonValue;
  await prisma.appSetting.upsert({ where: { key: ACCOUNTS_KEY }, create: { key: ACCOUNTS_KEY, value, updatedById: userId }, update: { value, updatedById: userId } });
}

/** The key Orbit reads Agent37 with, if one is set on this server. */
function agent37Client(env: NodeJS.ProcessEnv = process.env): Agent37Client | null {
  const key = env.AGENT37_API_KEY;
  return key && key.trim() ? new Agent37Client({ key }) : null;
}

export interface BuildOptions {
  now?: Date;
  fetchImpl?: FetchLike;
  agent37?: Pick<Agent37Client, 'billing'> | null;
  /** Read only this company again (after a top up); the others keep their last reading. */
  onlyCompany?: string;
  userId?: string | null;
  /** Tell super admins about the warnings that call for it. The page does; a plain read does not. */
  notify?: boolean;
}

/** The recent pace at each company, from the books, in millionths of a dollar a day. */
async function paces(now: Date, days: number): Promise<Record<string, number | null>> {
  const [deepseek, agent37, elevenlabs] = await Promise.all([
    paceFor([{ pool: 'chat', kind: 'model_call' }, { pool: 'computer', kind: 'model_call' }], now, days),
    paceFor([{ pool: 'computer', kind: 'computer_time' }], now, days),
    paceFor([{ kind: 'speech' }], now, days),
  ]);
  return { deepseek, agent37, elevenlabs };
}

const AREA_WORDS: Record<string, string> = { computer: 'Computers', apps: 'Apps', speech: 'Speech' };

async function asks(): Promise<AskView[]> {
  const open = await openRequests();
  if (open.length === 0) return [];
  const people = await prisma.user.findMany({ where: { id: { in: open.map((request) => request.personId) } }, select: { id: true, name: true } });
  const names = new Map(people.map((person) => [person.id, person.name]));
  const wokas = await wokaLayersForMany(open.map((request) => request.personId)).catch(() => new Map<string, string[]>());
  return open.map((request) => ({
    personId: request.personId,
    name: names.get(request.personId) ?? 'Someone',
    woka: wokas.get(request.personId) ?? [],
    area: AREA_WORDS[request.what] ?? request.what,
    what: request.what === 'computer' ? 'Used up their computer time this month' : `Reached their own ${AREA_WORDS[request.what] ?? request.what} allowance this month`,
    askedAt: request.createdAt.toISOString(),
  }));
}

async function changes(): Promise<ChangeView[]> {
  const lines = await listChanges({ take: 100 });
  const ids = [...new Set(lines.map((line) => line.changedById).filter((id): id is string => !!id))];
  const people = ids.length > 0 ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const names = new Map(people.map((person) => [person.id, person.name ?? 'A super admin']));
  const out: ChangeView[] = [];
  for (const line of lines) {
    const def = numberById(`${line.store}:${line.key}`);
    out.push({
      id: line.id,
      numberId: `${line.store}:${line.key}`,
      label: def?.label ?? line.key,
      unit: def?.unit ?? 'count',
      oldValue: line.oldValue,
      newValue: line.newValue,
      by: line.changedById ? (names.get(line.changedById) ?? 'A super admin') : 'Orbit',
      at: line.changedAt,
      note: line.note,
    });
  }
  return out;
}

async function numberViews(values: Values): Promise<NumberView[]> {
  const last = await lastChanges();
  const ids = [...new Set([...last.values()].map((line) => line.changedById).filter((id): id is string => !!id))];
  const people = ids.length > 0 ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const names = new Map(people.map((person) => [person.id, person.name ?? 'A super admin']));
  const out: NumberView[] = [];
  for (const def of NUMBER_DEFS) {
    if (!available(def)) continue;
    const change = last.get(def.id);
    out.push({
      id: def.id,
      label: def.label,
      hint: def.hint,
      unit: def.unit,
      group: def.group,
      area: def.area,
      value: valueOf(def, values),
      range: rangeOf(def)!,
      lastChange: change ? { by: change.changedById ? (names.get(change.changedById) ?? 'A super admin') : 'Orbit', at: change.changedAt } : null,
    });
  }
  return out;
}

/** What members fund themselves, apart from what Universe pays, and what one thing costs on average (priced uses only). */
async function funding(now: Date, areas: AreaView[]): Promise<BudgetReport['funding']> {
  const [own, replies, apps, instant] = await Promise.all([
    monthSum({ payer: 'person' }, now),
    monthSum({ pool: 'chat', kind: 'model_call' }, now),
    monthSum({ pool: 'chat', kind: 'app_use', route: 'app' }, now),
    monthSum({ pool: 'chat', kind: 'app_use', route: 'instant' }, now),
  ]);
  const average = (sum: { costMicros: number; events: number; unpriced: number }) => (sum.events - sum.unpriced > 0 ? Math.round(sum.costMicros / (sum.events - sum.unpriced)) : null);
  const perTask: BudgetReport['funding']['perTask'] = [];
  const add = (label: string, sum: { costMicros: number; events: number; unpriced: number }) => {
    const micros = average(sum);
    if (micros !== null) perTask.push({ label, micros, count: sum.events - sum.unpriced });
  };
  add('A chat reply', replies);
  add('A connected App step', apps);
  add('An Instant App run', instant);
  const gross = areas.reduce((sum, area) => sum + area.spentMicros, 0);
  return { grossMicros: gross, paidByMembersMicros: own.costMicros, perTask };
}

export async function buildReport(options: BuildOptions = {}): Promise<BudgetReport> {
  const now = options.now ?? new Date();
  const values = await readValues();
  const previous = await storedAccounts();
  const sampleDays = values.budget.sampleDays ?? 1;
  const [pace, pause, appsMonth, instantMonth] = await Promise.all([
    paces(now, sampleDays),
    getInstantPause().catch(() => null),
    monthSum({ pool: 'chat', kind: 'app_use', route: 'app' }, now),
    monthSum({ pool: 'chat', kind: 'app_use', route: 'instant' }, now),
  ]);
  const { accounts, fresh } = await readAccounts(
    { now, fetchImpl: options.fetchImpl, agent37: options.agent37 === undefined ? agent37Client() : options.agent37, pace, composioEmpty: pause?.paused === true && pause.reason === 'provider_empty', ours: { composio: appsMonth.costMicros + instantMonth.costMicros } },
    previous,
    options.onlyCompany,
  );
  await saveAccounts(previous, fresh, options.userId ?? null).catch((error) => console.error('[Budget] Could not keep the readings:', error instanceof Error ? error.message : 'unknown'));
  const { areas, keptMicros } = await buildAreas({ now, values, accounts });
  const warnings: Warning[] = buildWarnings(areas, accounts, values.budget);
  if (options.notify) await sendNotices(warnings, now).catch((error) => console.error('[Budget] Could not send the notices:', error instanceof Error ? error.message : 'unknown'));
  const funded = areas.filter((area) => area.budgetMicros !== null && area.key !== 'chat');
  const chat = areas.find((area) => area.key === 'chat');
  const forecastTotal = funded.reduce((sum, area) => sum + area.forecastMicros, 0);
  const month = monthOf(now);
  const days = values.budget.sampleDays;
  return {
    readAt: now.toISOString(),
    monthTurns: month.end.toISOString(),
    covers: 'Covers Speech, Apps, Computers and new Storage. Chat is not in it.',
    basis: days === null ? 'The forecast settings are not set, so no forecast is shown.' : `Forecasts use the last ${days} day${days === 1 ? '' : 's'}.`,
    total: {
      budgetMicros: funded.reduce((sum, area) => sum + (area.budgetMicros ?? 0), 0),
      spentMicros: areas.filter((area) => area.key !== 'chat').reduce((sum, area) => sum + area.spentMicros, 0),
      heldMicros: areas.reduce((sum, area) => sum + area.heldMicros, 0),
      forecastMicros: forecastTotal,
      // Adds chat and everything already kept: what the platform costs this month if the funded areas are used as forecast
      platformMicros: forecastTotal + (chat?.forecastMicros ?? 0) + (areas.find((area) => area.key === 'storage')?.budgetMicros === null ? keptMicros : 0),
      unsetAreas: areas.filter((area) => area.key !== 'chat' && area.budgetMicros === null && !area.lines).map((area) => area.key),
    },
    alerts: warnings.map((warning) => warning.alert),
    areas,
    accounts,
    numbers: await numberViews(values),
    changes: await changes(),
    asks: await asks(),
    funding: await funding(now, areas),
  };
}

export type { AccountView };
