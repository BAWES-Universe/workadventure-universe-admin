'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Ban, Check, Flag, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/components/ui/toast';
import { timeAgo } from '@/lib/time-ago';
import { cn } from '@/lib/utils';
import { EmptyCard, EntityRow, LoadError, LoadingRows, RolePill, SectionHeader, StatLine } from './ds';
import { PersonIcon } from './profile-card';
import { RoleChoice } from './role-choice';

/** A reported player with the reports about them still waiting for a decision. */
interface ReportedPerson {
  key: string;
  userId: string | null;
  name: string;
  isGuest: boolean;
  woka?: string[];
  reports: { id: string; comment: string; createdAt: string; reporterName: string; roomName: string | null }[];
}

/** One decision about a player's reports. */
interface HandledReports {
  key: string;
  userId: string | null;
  name: string;
  woka?: string[];
  count: number;
  roomName: string | null;
  outcome: 'dismissed' | 'banned';
  handledByName: string;
  handledAt: string | null;
}

interface WorldBan {
  id: string;
  userId: string | null;
  name: string;
  isGuest: boolean;
  woka?: string[];
  expiresAt: string | null;
  reason: string | null;
  bannedByName: string;
  bannedAt: string;
  appeal: { text: string; sentAt: string } | null;
}

export interface WorldSafetyData {
  open: ReportedPerson[];
  done: HandledReports[];
  bans: WorldBan[];
  counts: { reports: number; appeals: number };
}

const DURATIONS = [
  { value: '1d', label: '1 day', description: 'Back tomorrow, a cooling-off' },
  { value: '7d', label: '7 days', description: 'Back next week' },
  { value: 'forever', label: 'Forever', description: 'Until an admin lifts the ban' },
];

/** The coral of a step that keeps someone out. */
const DANGER = 'bg-[#E96D51] text-white hover:bg-[#E96D51]/90';

const reportCount = (count: number) => (count === 1 ? '1 report' : `${count} reports`);
const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const until = (ban: WorldBan) => (ban.expiresAt ? `Until ${shortDate(ban.expiresAt)}` : 'Forever');
const profileHref = (userId: string | null) => (userId ? `/admin/users/${userId}` : null);

/**
 * A world's reports and bans, for the people who run it (its admins and its universe's owner). `null` until loaded,
 * and stays `null` for everyone else, so the page shows no Safety tab to them.
 */
export function useWorldSafety(worldId: string) {
  const [data, setData] = useState<WorldSafetyData | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/worlds/${worldId}/safety`);
      if (response.status === 403 || response.status === 401) return;
      if (!response.ok) throw new Error('Failed to load reports');
      setData(await response.json());
    } catch {
      setFailed(true);
    }
  }, [worldId]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, failed, reload: load };
}

/** What waits for the world's admins: reports to review, and appeals to answer. */
export const waitingCount = (data: WorldSafetyData | null) => (data ? data.counts.reports + data.counts.appeals : 0);

export default function WorldSafety({
  worldId,
  worldName,
  data,
  failed,
  reload,
}: {
  worldId: string;
  worldName: string;
  data: WorldSafetyData | null;
  failed: boolean;
  reload: () => Promise<void>;
}) {
  const { addToast } = useToast();
  const [show, setShow] = useState<'open' | 'done'>('open');
  const [banning, setBanning] = useState<ReportedPerson | null>(null);
  const [lifting, setLifting] = useState<WorldBan | null>(null);
  const [duration, setDuration] = useState('7d');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function act(busyKey: string, body: Record<string, string>, done: string): Promise<boolean> {
    setBusy(busyKey);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/worlds/${worldId}/safety`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'That didn’t work. Try again.');
      addToast({ description: done, variant: 'success' });
      await reload();
      return true;
    } catch (error) {
      addToast({ description: error instanceof Error ? error.message : 'That didn’t work. Try again.', variant: 'error' });
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return failed ? <LoadError label="reports" retry={reload} /> : <LoadingRows label="reports" />;
  }

  const appeals = data.bans.filter((ban) => ban.appeal);
  const otherBans = data.bans.filter((ban) => !ban.appeal);

  return (
    <div className="max-w-3xl space-y-8">
      <section aria-labelledby="world-reports" className="space-y-3">
        <SectionHeader id="world-reports" title="Reports" count={show === 'open' ? data.counts.reports : undefined} />
        <p className="-mt-1 text-sm text-muted-foreground">
          What players reported in {worldName}. Only you and the other admins see this.
        </p>
        <div className="flex gap-2" role="tablist" aria-label="Which reports">
          {(['open', 'done'] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={show === key}
              onClick={() => setShow(key)}
              className={cn(
                'orbit-press h-9 rounded-full px-4 text-sm font-semibold transition-colors',
                show === key ? 'bg-[image:var(--brand-gradient)] text-white' : 'border border-border/70 text-muted-foreground hover:text-foreground',
              )}
            >
              {key === 'open' ? `To review · ${data.counts.reports}` : 'Done'}
            </button>
          ))}
        </div>

        {show === 'open' ? (
          data.open.length === 0 ? (
            <EmptyCard kind="people" title="Nothing to review." text="When a player reports someone in this world, it shows up here." />
          ) : (
            <div className="space-y-3">
              {data.open.map((person) => {
                const href = profileHref(person.userId);
                return (
                  <article key={person.key} className="orbit-card space-y-3 p-4" data-testid="report-card">
                    <div className="flex items-center gap-3">
                      <PersonIcon woka={person.woka} name={person.name} />
                      <div className="min-w-0 flex-1">
                        {href ? (
                          <Link href={href} className="block truncate text-[15px] font-semibold hover:underline">
                            {person.name}
                          </Link>
                        ) : (
                          <span className="block truncate text-[15px] font-semibold">{person.name}</span>
                        )}
                        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                          <StatLine items={[reportCount(person.reports.length), `latest ${timeAgo(new Date(person.reports[0].createdAt))}`]} />
                          {person.isGuest && <RolePill role="guest" />}
                        </span>
                      </div>
                    </div>
                    <ul className="space-y-2">
                      {person.reports.map((report) => (
                        <li key={report.id} className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
                          {report.comment ? (
                            <p className="whitespace-pre-line break-words text-sm text-foreground/90">“{report.comment}”</p>
                          ) : (
                            <p className="text-sm italic text-muted-foreground">No message</p>
                          )}
                          <p className="mt-1 text-xs text-muted-foreground">
                            <StatLine items={[report.reporterName, report.roomName && `in ${report.roomName}`, timeAgo(new Date(report.createdAt))]} />
                          </p>
                        </li>
                      ))}
                    </ul>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="destructive"
                        className={cn('h-11 px-5', DANGER)}
                        disabled={busy !== null || !person.userId}
                        title={person.userId ? undefined : 'This player hasn’t entered Universe since, so they can’t be banned yet'}
                        onClick={() => {
                          setDuration('7d');
                          setReason('');
                          setBanning(person);
                        }}
                      >
                        <Ban aria-hidden="true" />
                        Ban from {worldName}
                      </Button>
                      <Button
                        variant="outline"
                        className="h-11 px-5"
                        disabled={busy !== null}
                        onClick={() => act(`dismiss-${person.key}`, { action: 'dismiss', person: person.key }, `Dismissed the reports about ${person.name}`)}
                      >
                        {busy === `dismiss-${person.key}` ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
                        Dismiss
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          )
        ) : data.done.length === 0 ? (
          <EmptyCard kind="people" title="Nothing handled yet." text="Reports you dismiss or act on move here, with who handled them." />
        ) : (
          <div>
            {data.done.map((item) => (
              <EntityRow
                key={item.key}
                href={profileHref(item.userId) ?? '#'}
                kind="people"
                leading={<PersonIcon woka={item.woka} name={item.name} />}
                title={item.name}
                context={<StatLine items={[reportCount(item.count), item.roomName && `in ${item.roomName}`]} />}
                meta={
                  <span className="text-xs text-muted-foreground">
                    <StatLine items={[`${item.outcome === 'banned' ? 'Banned' : 'Dismissed'} by ${item.handledByName}`, item.handledAt && timeAgo(new Date(item.handledAt))]} />
                  </span>
                }
              />
            ))}
          </div>
        )}
      </section>

      <section id="world-bans" aria-labelledby="world-bans-title" className="space-y-3">
        <SectionHeader id="world-bans-title" title="Banned" count={data.bans.length} />
        {data.bans.length === 0 ? (
          <EmptyCard kind="people" title="Nobody is banned." text="People you ban from this world show up here, so you can lift it." />
        ) : (
          <div className="space-y-3">
            {appeals.map((ban) => (
              <article key={ban.id} className="orbit-card space-y-3 p-4" data-testid="appeal-card">
                <div className="flex items-center gap-3">
                  <PersonIcon woka={ban.woka} name={ban.name} />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold">{ban.name} asks to be let back in</span>
                    <span className="block text-xs text-muted-foreground">
                      <StatLine items={[until(ban), `banned by ${ban.bannedByName}`, ban.reason && `“${ban.reason}”`]} />
                    </span>
                  </div>
                </div>
                <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
                  <p className="whitespace-pre-line break-words text-sm text-foreground/90">“{ban.appeal?.text}”</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Appeal · {ban.appeal ? timeAgo(new Date(ban.appeal.sentAt)) : ''} · their only one for this ban
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="h-11 px-5"
                    disabled={busy !== null}
                    onClick={() => act(`lift-${ban.id}`, { action: 'lift', banId: ban.id }, `${ban.name} can enter ${worldName} again`)}
                  >
                    {busy === `lift-${ban.id}` ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
                    Lift ban
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11 px-5"
                    disabled={busy !== null}
                    onClick={() => act(`keep-${ban.id}`, { action: 'keep', banId: ban.id }, `Kept the ban. ${ban.name} sees your answer.`)}
                  >
                    Keep ban
                  </Button>
                </div>
              </article>
            ))}
            {otherBans.length > 0 && (
              <div>
                {otherBans.map((ban) => (
                  <EntityRow
                    key={ban.id}
                    href={profileHref(ban.userId) ?? '#'}
                    kind="people"
                    leading={<PersonIcon woka={ban.woka} name={ban.name} />}
                    title={ban.name}
                    context={<StatLine items={[until(ban), `by ${ban.bannedByName}`, timeAgo(new Date(ban.bannedAt))]} />}
                    meta={ban.reason ? <span className="block truncate text-xs italic text-muted-foreground">“{ban.reason}”</span> : undefined}
                    trailing={
                      <Button variant="outline" className="h-9 px-4" disabled={busy !== null} onClick={() => setLifting(ban)}>
                        Lift ban
                      </Button>
                    }
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <AlertDialog open={banning !== null} onOpenChange={(open) => !open && setBanning(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Ban {banning?.name} from {worldName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They’re sent out now and can’t enter any room in {worldName} until the ban ends. The reports are marked done.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <p id="ban-for" className="text-sm font-medium">
              For how long
            </p>
            <RoleChoice value={duration} onChange={setDuration} options={DURATIONS} name="duration" labelledBy="ban-for" />
          </div>
          <div className="space-y-2">
            <label htmlFor="ban-reason" className="text-sm font-medium">
              What to tell them <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Input
              id="ban-reason"
              value={reason}
              maxLength={200}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Spamming links in Lobby"
            />
            <p className="text-xs text-muted-foreground">They see this when they try to enter. The reports stay private.</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className={DANGER}
              disabled={busy !== null}
              onClick={async (event) => {
                event.preventDefault();
                if (!banning) return;
                const ok = await act(`ban-${banning.key}`, { action: 'ban', person: banning.key, duration, reason }, `${banning.name} is banned from ${worldName}`);
                if (ok) setBanning(null);
              }}
            >
              {busy?.startsWith('ban-') ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Ban aria-hidden="true" />}
              Ban
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={lifting !== null} onOpenChange={(open) => !open && setLifting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Lift {lifting?.name}’s ban?</AlertDialogTitle>
            <AlertDialogDescription>They can enter {worldName} again right away.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy !== null}
              onClick={async (event) => {
                event.preventDefault();
                if (!lifting) return;
                const ok = await act(`lift-${lifting.id}`, { action: 'lift', banId: lifting.id }, `${lifting.name} can enter ${worldName} again`);
                if (ok) setLifting(null);
              }}
            >
              {busy?.startsWith('lift-') ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
              Lift ban
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** One report waiting, or the worlds with reports and appeals waiting, from the home summary. */
export interface ReportsSummary {
  total: number;
  worlds: { id: string; name: string; universeName: string; reports: number; appeals: number }[];
  latest: {
    worldId: string;
    worldName: string;
    reportedName: string;
    reporterName: string;
    roomName: string | null;
    comment: string;
    createdAt: string;
  } | null;
}

const REPORT_CARD =
  'orbit-rise relative min-w-0 rounded-[18px] bg-card bg-[linear-gradient(160deg,rgb(134_41_252/0.10),transparent_55%)] p-4 shadow-[inset_0_0_0_1px_rgb(167_139_250/0.28),0_18px_40px_-24px_rgb(134_41_252/0.55)]';

function FlagTile() {
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[image:var(--brand-gradient)] text-white shadow-[0_8px_20px_-8px_rgb(134_41_252/0.8)]">
      <Flag className="h-5 w-5" aria-hidden="true" />
    </span>
  );
}

function CountBadge({ n }: { n: number }) {
  return (
    <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-[image:var(--brand-gradient)] px-2 text-xs font-bold tabular-nums text-white">
      {n}
    </span>
  );
}

const safetyHref = (worldId: string) => `/admin/worlds/${worldId}?tab=safety`;

/** Orbit home: reports and appeals waiting in the worlds you look after. Nothing shows when nothing waits. */
export function ReportsAlert() {
  const [summary, setSummary] = useState<ReportsSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch('/api/admin/reports/summary');
        if (!response.ok) return;
        const data: ReportsSummary = await response.json();
        if (!cancelled) setSummary(data);
      } catch {
        // The card is extra: without it the home page still works
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!summary || summary.total === 0) return null;

  const { latest } = summary;
  if (latest) {
    return (
      <div className={cn(REPORT_CARD, 'flex gap-3')} data-testid="reports-alert">
        <FlagTile />
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <p className="text-[15px] font-semibold">
              {latest.reporterName} reported {latest.reportedName} in {latest.worldName}
            </p>
            <p className="text-sm text-muted-foreground">
              <StatLine items={[latest.roomName && `in ${latest.roomName}`, timeAgo(new Date(latest.createdAt))]} />
            </p>
            {latest.comment && <p className="line-clamp-2 break-words text-sm italic text-foreground/80">“{latest.comment}”</p>}
          </div>
          <Button asChild className="h-11 px-5">
            <Link href={safetyHref(latest.worldId)}>Review</Link>
          </Button>
        </div>
      </div>
    );
  }

  const reports = summary.worlds.reduce((sum, world) => sum + world.reports, 0);
  const appeals = summary.total - reports;
  const appealsOnly = reports === 0;
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const title = appealsOnly
    ? `${plural(appeals, 'appeal')} to answer`
    : `${plural(reports, 'report')}${appeals ? ` and ${plural(appeals, 'appeal')}` : ''} to review`;
  return (
    <div className={cn(REPORT_CARD, 'space-y-3')} data-testid="reports-alert">
      <div className="flex items-center gap-3">
        <FlagTile />
        <p className="text-[15px] font-semibold">{title}</p>
      </div>
      <div className="space-y-2">
        {summary.worlds.map((world) => (
          <EntityRow
            key={world.id}
            href={safetyHref(world.id)}
            kind="world"
            title={world.name}
            context={
              <span className="text-sm text-muted-foreground">
                <StatLine
                  items={[
                    world.universeName,
                    !appealsOnly && world.appeals > 0 && (world.appeals === 1 ? '1 appeal' : `${world.appeals} appeals`),
                  ]}
                />
              </span>
            }
            aside={<CountBadge n={world.reports + world.appeals} />}
          />
        ))}
      </div>
    </div>
  );
}
