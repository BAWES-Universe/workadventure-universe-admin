'use client';

import { useEffect, useState } from 'react';
import { ChevronRight, Info, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PickCard, Radio } from '@/components/ui/choice';
import { useToast } from '@/components/ui/toast';
import { FormSheet } from './form-sheet';
import { LoadError, LoadingRows, SectionHeader, SettingSwitch, Settings } from './ds';
import {
  ARTIFACT_LIMITS_RECOMMENDED,
  FAIR_USAGE_RECOMMENDED,
  FAIR_USAGE_WINDOW_HOURS,
  FILE_LIMITS_RECOMMENDED,
  LIMIT_RANGES,
  REPLY_LIMITS_RECOMMENDED,
  replyLimitsProblem,
  type ArtifactLimits,
  type FairUsage,
  type FileLimits,
  type Range,
  type ReplyLimits,
  type ServerLimits,
} from '@/lib/bot-limit-values';

/** One limit that shapes bot replies or artifacts (#666): what it is, its value, and the recommended one. */
export interface LimitOption {
  value: number;
  label: string;
  meaning: string;
}
export interface Limit {
  id: string;
  label: string;
  hint: string;
  unit: string;
  value: number;
  recommended: number;
  options: LimitOption[];
  /** Shown under the choices in the sheet: cost or what it affects. */
  note?: string;
  /** No "Other" box (a choice between fixed steps). */
  fixedSteps?: boolean;
  /** A model that stops below this value (#673): where it stops, the line that says so, and the words on each choice above it. */
  cap?: ModelCap;
  /** The values it can be set to, said on its sheet; Other outside them is turned down there. */
  range?: Range;
  /** Another row it can't go above: a choice past it is turned down with this line, never cut to fit. */
  atMost?: { value: number; line: string };
}

export interface ModelCap {
  at: number;
  /** Null when no bot stops below the value set now: the choices above `at` still say where it stops. */
  line: string | null;
  short: string;
}

export function shown(limit: Limit, value = limit.value): string {
  const option = limit.options.find((entry) => entry.value === value);
  return option ? option.label : `${value.toLocaleString('en')} ${limit.unit}`;
}

/** The neutral pill that marks the recommended value: a fact, so it is neither violet nor gradient. */
export function RecommendedPill() {
  return (
    <span className="inline-flex h-[22px] items-center whitespace-nowrap rounded-full border border-foreground/15 px-2.5 text-[11px] font-semibold text-foreground/85">
      Recommended
    </span>
  );
}

/** One row: what it is, what it does, and its value; the whole row opens the choices. */
export function LimitRow({ limit, onOpen }: { limit: Limit; onOpen: () => void }) {
  const isRecommended = limit.value === limit.recommended;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`limit-${limit.id}`}
      className="flex min-h-16 w-full items-center gap-4 rounded-[14px] border border-border bg-card px-3.5 py-3 text-left transition-colors hover:border-foreground/20"
    >
      <span className="grid min-w-0 flex-1 gap-0.5">
        <strong className="text-sm font-semibold">{limit.label}</strong>
        <span className="text-xs leading-snug text-muted-foreground">{limit.hint}</span>
        {limit.cap?.line && (
          <span className="mt-1 flex items-start gap-1.5 text-xs leading-snug text-foreground/85" data-testid={`limit-${limit.id}-cap`}>
            <Info size={14} aria-hidden="true" className="mt-px shrink-0 text-muted-foreground" />
            {limit.cap.line}
          </span>
        )}
        <span className="mt-1.5 flex flex-wrap items-center gap-2 sm:hidden">
          <span className="text-sm font-bold">{shown(limit)}</span>
          {isRecommended ? <RecommendedPill /> : <span className="text-[11px] text-muted-foreground">Recommended: {shown(limit, limit.recommended)}</span>}
        </span>
      </span>
      <span className="hidden shrink-0 justify-items-end gap-1 sm:grid">
        <span className="text-sm font-bold">{shown(limit)}</span>
        {isRecommended ? <RecommendedPill /> : <span className="text-[11px] text-muted-foreground">Recommended: {shown(limit, limit.recommended)}</span>}
      </span>
      <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-muted-foreground" />
    </button>
  );
}

/** The choices for one limit: radio cards with what each means, the recommended one marked, and Other. */
export function LimitChoices({ limit, onDone, onCancel }: { limit: Limit; onDone: (value: number) => Promise<void> | void; onCancel: () => void }) {
  const known = limit.options.some((option) => option.value === limit.value);
  const [picked, setPicked] = useState<number | 'other'>(known ? limit.value : 'other');
  const [other, setOther] = useState(known ? '' : String(limit.value));
  const [saving, setSaving] = useState(false);
  // What was typed is read as it is, with commas and spaces as thousands marks: "-50" or "1e2" is refused, not turned into 50 or 12
  const typed = other.replace(/[,\s]/g, '');
  const value = picked === 'other' ? (typed === '' ? 0 : /^\d+(\.\d+)?$/.test(typed) ? Number(typed) : Number.NaN) : picked;
  const range = limit.range;
  // A row that can't go above another says the lower of the two as its most
  const most = range ? Math.min(range.max, limit.atMost?.value ?? range.max) : 0;
  const rangeLine = range ? `Between ${range.min.toLocaleString('en')} and ${most.toLocaleString('en')} ${limit.unit}.` : null;
  const outOfRange = picked === 'other' && other.trim() !== '' && !!range && (Number.isNaN(value) || value < range.min || value > range.max || (!!range.whole && !Number.isInteger(value)));
  const aboveOther = !!limit.atMost && value > limit.atMost.value;
  // "Never" (0) is a choice of its own; an empty or 0 "Other" is not
  const ready = (picked === 'other' ? value > 0 : true) && !outOfRange && !aboveOther;
  return (
    <div className="grid gap-4">
      {limit.cap?.line && (
        <p className="flex items-start gap-2 rounded-xl bg-foreground/[.04] px-3.5 py-2.5 text-sm">
          <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground" />
          {limit.cap.line}
        </p>
      )}
      <div role="radiogroup" aria-label={limit.label} className="grid gap-2">
        {limit.options.map((option) => (
          <PickCard
            key={option.value}
            role="radio"
            picked={picked === option.value}
            onClick={() => setPicked(option.value)}
            indicator={<Radio checked={picked === option.value} />}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {option.label}
                {option.value === limit.recommended && <RecommendedPill />}
              </span>
            }
            description={limit.cap && option.value > limit.cap.at ? `${option.meaning} ${limit.cap.short}` : option.meaning}
          />
        ))}
        {!limit.fixedSteps && (
          <>
            <PickCard role="radio" picked={picked === 'other'} onClick={() => setPicked('other')} indicator={<Radio checked={picked === 'other'} />} title="Other" />
            {picked === 'other' && (
              <span className="grid gap-1.5 px-3.5">
                <span className="flex items-center gap-2">
                  <Input
                    inputMode="decimal"
                    value={other}
                    onChange={(event) => setOther(event.target.value)}
                    className="h-11 w-36"
                    aria-label={`${limit.label}, in ${limit.unit}`}
                    aria-invalid={outOfRange || undefined}
                    aria-describedby={rangeLine ? `limit-${limit.id}-range` : undefined}
                  />
                  <span className="text-sm text-muted-foreground">{limit.unit}</span>
                </span>
                {rangeLine && (
                  <span id={`limit-${limit.id}-range`} role={outOfRange ? 'alert' : undefined} className={outOfRange ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'} data-testid={`limit-${limit.id}-range`}>
                    {rangeLine}
                  </span>
                )}
              </span>
            )}
          </>
        )}
      </div>
      {aboveOther && (
        <p role="alert" className="text-sm text-destructive" data-testid={`limit-${limit.id}-above`}>
          {limit.atMost!.line}
        </p>
      )}
      {limit.note && <p className="text-sm text-muted-foreground">{limit.note}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" className="h-11 px-5" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          className="h-11 px-5"
          disabled={!ready || saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onDone(value);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
          Save
        </Button>
      </div>
    </div>
  );
}

/**
 * A group of limits under a small heading; tapping a row opens its choices in a sheet. `onChange` saves one value and
 * says whether it was saved: the sheet closes only then, so a value that was turned down can be fixed.
 */
export function LimitGroup({ title, note, limits, onChange }: { title: string; note?: string; limits: Limit[]; onChange: (id: string, value: number) => Promise<boolean> }) {
  const [open, setOpen] = useState<Limit | null>(null);
  return (
    <section className="grid gap-2" aria-label={title}>
      <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{title}</h3>
      {note && <p className="-mt-1 text-sm text-muted-foreground">{note}</p>}
      {limits.map((limit) => (
        <LimitRow key={limit.id} limit={limit} onOpen={() => setOpen(limit)} />
      ))}
      <FormSheet open={open !== null} onOpenChange={(value) => !value && setOpen(null)} title={open?.label ?? ''} description={open?.hint}>
        {open && (
          <LimitChoices
            key={open.id}
            limit={open}
            onCancel={() => setOpen(null)}
            onDone={async (value) => {
              if (await onChange(open.id, value)) setOpen(null);
            }}
          />
        )}
      </FormSheet>
    </section>
  );
}

const TOKENS = 'tokens';
const every = `Every ${FAIR_USAGE_WINDOW_HOURS} hours.`;

/** Each row with the values it can be set to, said on its sheet. */
const withRanges = (rows: Limit[], ranges: Record<string, Range>): Limit[] => rows.map((row) => (ranges[row.id] ? { ...row, range: ranges[row.id] } : row));

/** The reply limits, with the recommended values. Universe AI and every key use the same rows. */
export function replyLimits(values: ReplyLimits): Limit[] {
  const recommended = REPLY_LIMITS_RECOMMENDED;
  // The line the server answers with, so the sheet and a refused save say the same thing
  const aboveRead = replyLimitsProblem({ ...values, part: values.read + 1 }) as string;
  return withRanges([
    {
      id: 'reply',
      label: 'Longest reply',
      hint: 'How much a bot can write in one go, an artifact included.',
      unit: TOKENS,
      value: values.reply,
      recommended: recommended.reply,
      options: [
        { value: 4000, label: '4,000 tokens', meaning: 'A short page. Bigger files get cut off.' },
        { value: 8000, label: '8,000 tokens', meaning: 'A small app.' },
        { value: 16000, label: '16,000 tokens', meaning: 'A page with charts and several sections.' },
        { value: 32000, label: '32,000 tokens', meaning: 'A full app, with room for the model to think first.' },
        { value: 64000, label: '64,000 tokens', meaning: 'Very large apps. Only some models allow this much.' },
      ],
      note: 'Chats stay short either way: this only sets how far a bot may go. You pay for what it writes, not for the limit.',
    },
    {
      id: 'steps',
      label: 'Steps in one reply',
      hint: 'Tools a bot may use before it answers: searching, reading, building.',
      unit: 'steps',
      value: values.steps,
      recommended: recommended.steps,
      options: [
        { value: 10, label: '10 steps', meaning: 'A few lookups, then an answer.' },
        { value: 20, label: '20 steps', meaning: 'Research, then build.' },
        { value: 30, label: '30 steps', meaning: 'Long research and building in parts.' },
        { value: 50, label: '50 steps', meaning: 'Very long jobs. Replies take longer.' },
      ],
    },
    {
      id: 'room',
      label: 'Room to work in one reply',
      hint: 'What a bot keeps of its searches, reads and makes while it answers. Past this, the oldest shrink to one line.',
      unit: 'characters',
      value: values.room,
      recommended: recommended.room,
      options: [
        { value: 40000, label: '40,000 characters', meaning: 'Small models. Older results shrink sooner.' },
        { value: 80000, label: '80,000 characters', meaning: 'Research and building in one reply.' },
        { value: 200000, label: '200,000 characters', meaning: 'Very long jobs on large models. Every step reads more.' },
      ],
      note: 'If a model still runs out of room, the older results shrink to their line and that step runs once more.',
    },
    {
      id: 'continue',
      label: 'Keep going when cut off',
      hint: 'Times a cut-off chat answer carries on by itself.',
      unit: 'times',
      value: values.continue,
      recommended: recommended.continue,
      fixedSteps: true,
      options: [
        { value: 0, label: 'Never', meaning: 'The answer stops where it was cut.' },
        { value: 1, label: 'Once', meaning: 'Then it stops.' },
        { value: 2, label: 'Twice', meaning: 'Then it stops.' },
        { value: 3, label: '3 times', meaning: 'Then it stops.' },
      ],
    },
    {
      id: 'memory',
      label: 'Messages it remembers',
      hint: 'Earlier messages in the chat a bot reads before each reply.',
      unit: 'messages',
      value: values.memory,
      recommended: recommended.memory,
      options: [
        { value: 8, label: 'Last 8', meaning: 'Short memory. Cheapest.' },
        { value: 20, label: 'Last 20', meaning: 'Follows a longer back and forth.' },
        { value: 50, label: 'Last 50', meaning: 'Long sessions. Every reply reads more.' },
      ],
    },
    {
      id: 'read',
      label: 'Reads from a page or file',
      hint: 'How much of a web page or file a bot takes in at once.',
      unit: 'characters',
      value: values.read,
      recommended: recommended.read,
      options: [
        { value: 10000, label: '10,000 characters', meaning: 'About 3 pages of text.' },
        { value: 50000, label: '50,000 characters', meaning: 'A long report or a full data table.' },
        { value: 100000, label: '100,000 characters', meaning: 'Very long documents.' },
      ],
    },
    {
      id: 'recentFiles',
      label: 'Newest files it sees',
      hint: 'This person’s newest files a bot sees before each reply, so it can reuse them without searching.',
      unit: 'files',
      value: values.recentFiles,
      recommended: recommended.recentFiles,
      options: [
        { value: 0, label: 'None', meaning: 'It searches for every file it needs.' },
        { value: 5, label: 'Newest 5', meaning: 'Covers “that song” and “the doc I sent”.' },
        { value: 10, label: 'Newest 10', meaning: 'Busy chats with many files.' },
        { value: 20, label: 'Newest 20', meaning: 'Every reply reads a little more.' },
      ],
    },
    {
      id: 'results',
      label: 'Files found in one search',
      hint: 'How many files and artifacts a bot gets back each time it searches for one.',
      unit: 'files',
      value: values.results,
      recommended: recommended.results,
      options: [
        { value: 5, label: '5 files', meaning: 'Small models. It asks for more when it needs to.' },
        { value: 10, label: '10 files', meaning: 'Enough to pick the right one most times.' },
        { value: 20, label: '20 files', meaning: 'Large libraries. Each search reads more.' },
      ],
    },
    {
      id: 'part',
      label: 'Reads from an earlier file',
      hint: 'How much of a file from an earlier message a bot opens at once. It reads on part by part.',
      unit: 'characters',
      value: values.part,
      recommended: recommended.part,
      options: [
        { value: 4000, label: '4,000 characters', meaning: 'About a page. Small models.' },
        { value: 8000, label: '8,000 characters', meaning: 'About 3 pages.' },
        { value: 20000, label: '20,000 characters', meaning: 'A chapter at a time.' },
      ],
      atMost: { value: values.read, line: aboveRead },
    },
    {
      id: 'wait',
      label: 'Wait for the AI',
      hint: 'How long a bot waits when its AI goes quiet before it gives up.',
      unit: 'seconds',
      value: values.wait,
      recommended: recommended.wait,
      options: [
        { value: 30, label: '30 seconds', meaning: 'Quick models.' },
        { value: 60, label: '60 seconds', meaning: 'Models that think before they write.' },
        { value: 120, label: '2 minutes', meaning: 'Slow or own-computer models.' },
      ],
    },
  ], LIMIT_RANGES.reply);
}

/** The artifact limits: for all bots, set by a super admin. */
export function artifactLimits(values: ArtifactLimits): Limit[] {
  const recommended = ARTIFACT_LIMITS_RECOMMENDED;
  const keepsUntil = 'Then changes stop until a new artifact is made.';
  return withRanges([
    {
      id: 'size',
      label: 'Size of one version',
      hint: 'The largest file an artifact can be.',
      unit: 'MB',
      value: values.size,
      recommended: recommended.size,
      options: [
        { value: 0.5, label: '512 KB', meaning: 'Pages and apps without pictures.' },
        { value: 1, label: '1 MB', meaning: 'Large apps with long data tables.' },
        { value: 2, label: '2 MB', meaning: 'Room for small pictures inside the file.' },
        { value: 10, label: '10 MB', meaning: 'Big pictures inside the file.' },
      ],
    },
    {
      id: 'versions',
      label: 'Versions kept',
      hint: 'Older versions of one artifact you can go back to.',
      unit: 'versions',
      value: values.versions,
      recommended: recommended.versions,
      options: [
        { value: 200, label: '200', meaning: keepsUntil },
        { value: 1000, label: '1,000', meaning: keepsUntil },
        { value: 0, label: 'All of them', meaning: 'Every version stays.' },
      ],
    },
    {
      id: 'save',
      label: 'Time to save',
      hint: 'How long saving a version may take before the bot is told it failed.',
      unit: 'seconds',
      value: values.save,
      recommended: recommended.save,
      options: [
        { value: 20, label: '20 seconds', meaning: 'Small files.' },
        { value: 30, label: '30 seconds', meaning: 'Files up to 2 MB.' },
        { value: 60, label: '60 seconds', meaning: 'Files up to 10 MB.' },
      ],
    },
    {
      id: 'media',
      label: 'Media added in one save',
      hint: 'The most songs, images and videos a bot can add to a page in one save. Files already on the page don’t count. If a bot goes over, nothing is saved and it is told the file doesn’t fit.',
      unit: 'MB',
      value: values.media,
      recommended: recommended.media,
      options: [
        { value: 0, label: 'None', meaning: 'Pages can’t play songs or show images from the chat.' },
        { value: 10, label: '10 MB', meaning: 'A few images, or one short song.' },
        { value: 50, label: '50 MB', meaning: 'A few songs, or a short video.' },
        { value: 200, label: '200 MB', meaning: 'Longer videos.' },
      ],
    },
    {
      id: 'mediaFiles',
      label: 'Files in one artifact',
      hint: 'The most songs, images and videos one artifact can hold. If a save would leave more, nothing is saved and the bot is told the limit.',
      unit: 'files',
      value: values.mediaFiles,
      recommended: recommended.mediaFiles,
      options: [
        { value: 20, label: '20 files', meaning: 'A playlist or a small gallery.' },
        { value: 50, label: '50 files', meaning: 'An album, or a gallery of a trip.' },
        { value: 200, label: '200 files', meaning: 'A big gallery or a music archive.' },
      ],
    },
  ], LIMIT_RANGES.artifacts);
}

/** What bots keep of the files in their chats (#1508): for all bots, set by a super admin. */
export function fileLimits(values: FileLimits): Limit[] {
  const recommended = FILE_LIMITS_RECOMMENDED;
  const notFound = 'Then the bot can’t find it, though it stays in the chat.';
  return withRanges([
    {
      id: 'text',
      label: 'Text kept from a file',
      hint: 'How much of a document bots keep, to find and read again later. The prompt a bot made a file with is kept the same way.',
      unit: 'characters',
      value: values.text,
      recommended: recommended.text,
      options: [
        { value: 500000, label: '500,000 characters', meaning: 'About 150 pages.' },
        { value: 2000000, label: '2,000,000 characters', meaning: 'About 600 pages, a long book.' },
        { value: 10000000, label: '10,000,000 characters', meaning: 'Very large files. Uses more storage.' },
      ],
    },
    {
      id: 'findable',
      label: 'Files bots can find again',
      hint: 'How long a file from a chat stays in the bot’s list. Asking a bot to forget you removes yours at once.',
      unit: 'days',
      value: values.findable,
      recommended: recommended.findable,
      options: [
        { value: 30, label: '30 days', meaning: notFound },
        { value: 365, label: '1 year', meaning: notFound },
        { value: 0, label: 'Always', meaning: 'Until the person asks the bot to forget them.' },
      ],
    },
    {
      id: 'guestDays',
      label: 'Guests’ files',
      hint: 'How long the files of someone who isn’t signed in stay, only in the chat they came in.',
      unit: 'days',
      value: values.guestDays,
      recommended: recommended.guestDays,
      options: [
        { value: 1, label: '1 day', meaning: 'The same as a guest’s artifacts.' },
        { value: 7, label: '7 days', meaning: 'Guests who come back to the same bubble.' },
        { value: 30, label: '30 days', meaning: 'Uses more storage.' },
      ],
    },
  ], LIMIT_RANGES.files);
}

/** Universe AI fair usage (#1159): how many replies one person gets, set here instead of in the server's settings. */
export function fairUsageLimits(values: FairUsage): Limit[] {
  const recommended = FAIR_USAGE_RECOMMENDED;
  return withRanges([
    {
      id: 'signedIn',
      label: 'Replies for a signed-in person',
      hint: `Across all Universe AI bots, every ${FAIR_USAGE_WINDOW_HOURS} hours.`,
      unit: 'replies',
      value: values.signedIn,
      recommended: recommended.signedIn,
      options: [
        { value: 30, label: '30 replies', meaning: every },
        { value: 60, label: '60 replies', meaning: every },
        { value: 100, label: '100 replies', meaning: every },
      ],
    },
    {
      id: 'guest',
      label: 'Replies for a guest',
      hint: `Someone who isn’t signed in, every ${FAIR_USAGE_WINDOW_HOURS} hours.`,
      unit: 'replies',
      value: values.guest,
      recommended: recommended.guest,
      options: [
        { value: 10, label: '10 replies', meaning: every },
        { value: 20, label: '20 replies', meaning: every },
      ],
    },
    {
      id: 'guestPool',
      label: 'Replies for all guests on one bot',
      hint: `Shared by every guest who talks to that bot, every ${FAIR_USAGE_WINDOW_HOURS} hours.`,
      unit: 'replies',
      value: values.guestPool,
      recommended: recommended.guestPool,
      options: [
        { value: 200, label: '200 replies', meaning: every },
        { value: 500, label: '500 replies', meaning: every },
      ],
    },
  ], LIMIT_RANGES.fairUsage);
}

/** The id without its maker's prefix: "openai/gpt-4o-mini" is "gpt-4o-mini". */
const shortModel = (id: string) => (id.includes('/') ? id.slice(id.indexOf('/') + 1) : id);
const listOf = (names: string[]) => new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(names);

type CapBot = { id: string; name: string; model: string | null; output: number | null };
type KnownBot = CapBot & { model: string; output: number };

/** Bots grouped by model, the model that stops soonest first. */
function byModel(bots: KnownBot[]): { model: string; output: number; names: string[] }[] {
  const groups = new Map<string, { output: number; names: string[] }>();
  for (const bot of bots) {
    const entry = groups.get(bot.model) ?? { output: bot.output, names: [] };
    if (!entry.names.includes(bot.name)) entry.names.push(bot.name);
    groups.set(bot.model, entry);
  }
  return [...groups.entries()].map(([model, entry]) => ({ model: shortModel(model), ...entry })).sort((a, b) => a.output - b.output);
}

/**
 * Where the models of a key's bots stop (#673), from what their providers say: null when no provider says. The line is
 * there only when some bot stops below the longest reply set now: "Scout runs on gpt-4o-mini, which stops at 16,384
 * tokens. Scout gets 16,384; your other bots get the full limit." The choices above where the soonest stops say so
 * either way, so picking 32,000 with 8,000 set still warns. A bot whose model's limit isn't known is never promised the
 * full limit.
 */
export function modelCapOf(bots: CapBot[], reply: number): ModelCap | null {
  const known = bots.filter((bot): bot is KnownBot => bot.model !== null && bot.output !== null);
  if (known.length === 0) return null;
  const soonest = byModel(known)[0];
  const groups = byModel(known.filter((bot) => bot.output < reply));
  const others = known.some((bot) => bot.output >= reply);
  const said = groups.map((group) => `${listOf(group.names)} ${group.names.length === 1 ? 'runs' : 'run'} on ${group.model}, which stops at ${group.output.toLocaleString('en')} tokens.`);
  const only = groups.length === 1 ? groups[0] : null;
  const gets = only
    ? `${listOf(only.names)} ${only.names.length === 1 ? 'gets' : 'get'} ${only.output.toLocaleString('en')}`
    : 'Each gets what its model allows';
  return {
    at: soonest.output,
    line: groups.length > 0 ? `${said.join(' ')} ${gets}${others ? '; your other bots get the full limit.' : '.'}` : null,
    short: `${soonest.model} stops at ${soonest.output.toLocaleString('en')} (${listOf(soonest.names)}).`,
  };
}

/** The key card's one line: "Recommended: replies up to 32,000 tokens, 30 steps", or "Yours: …" once changed. */
export function keyLimitsLine(values: ReplyLimits): string {
  const rows = replyLimits(values);
  const changed = rows.some((row) => row.value !== row.recommended);
  return `${changed ? 'Yours' : 'Recommended'}: replies up to ${shown(rows[0])}, ${shown(rows[1])}`;
}

async function sendLimits(url: string, body: unknown): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const { authenticatedFetch } = await import('@/lib/client-auth');
    const response = await authenticatedFetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, error: (data as { error?: string } | null)?.error || 'That didn’t save. Try again.' };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'That didn’t save. Check your connection and try again.' };
  }
}

/** Saves one of a key's reply limits (#666) and answers with all six as saved, or null when it was turned down (and says why). */
export function useSaveKeyLimit() {
  const { addToast } = useToast();
  return async (keyId: string, id: string, value: number): Promise<ReplyLimits | null> => {
    const result = await sendLimits(`/api/me/ai-keys/${encodeURIComponent(keyId)}`, { limits: { [id]: value } });
    if (!result.ok) {
      addToast({ description: result.error, variant: 'error' });
      return null;
    }
    addToast({ description: 'Saved', variant: 'success', duration: 2000 });
    return (result.data as { limits: ReplyLimits }).limits;
  };
}

/**
 * The Limits section of the Universe AI page (#666): Universe AI's reply limits, the artifact limits, files in chats,
 * the "Say when nothing was saved" switch and fair usage. Each value is saved as soon as it is picked.
 */
export function UniverseAiLimits() {
  const { addToast } = useToast();
  const [limits, setLimits] = useState<ServerLimits | null>(null);
  const [failed, setFailed] = useState(false);
  const [savingGuard, setSavingGuard] = useState(false);

  async function load() {
    setFailed(false);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/bot-limits');
      if (!response.ok) throw new Error('load');
      setLimits(((await response.json()) as { limits: ServerLimits }).limits);
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function save(change: Record<string, unknown>): Promise<boolean> {
    const result = await sendLimits('/api/admin/bot-limits', change);
    if (!result.ok) {
      addToast({ description: result.error, variant: 'error' });
      return false;
    }
    setLimits((result.data as { limits: ServerLimits }).limits);
    addToast({ description: 'Saved', variant: 'success', duration: 2000 });
    return true;
  }

  return (
    <section className="grid min-w-0 gap-5" aria-labelledby="limits" data-testid="universe-ai-limits">
      <SectionHeader id="limits" title="Limits" />
      {failed ? (
        <LoadError label="the limits" retry={load} />
      ) : !limits ? (
        <LoadingRows label="the limits" rows={3} />
      ) : (
        <>
          <LimitGroup
            title="Replies on Universe AI"
            note="People with their own key set these on their key. A bot’s editors can lower them for one bot."
            limits={replyLimits(limits.universeAi)}
            onChange={(id, value) => save({ universeAi: { [id]: value } })}
          />
          <LimitGroup title="Artifacts, for all bots" limits={artifactLimits(limits.artifacts)} onChange={(id, value) => save({ artifacts: { [id]: value } })} />
          <Settings label="Saving artifacts">
            <SettingSwitch
              id="guard"
              label="Say when nothing was saved"
              hint="If a bot says it made or changed an artifact but nothing was saved, the chat shows “No new version was saved” and the bot tries once more."
              checked={limits.guard}
              disabled={savingGuard}
              onChange={async (checked) => {
                setSavingGuard(true);
                await save({ guard: checked });
                setSavingGuard(false);
              }}
            />
          </Settings>
          <LimitGroup title="Files in chats, for all bots" limits={fileLimits(limits.files)} onChange={(id, value) => save({ files: { [id]: value } })} />
          <LimitGroup title="Fair usage" limits={fairUsageLimits(limits.fairUsage)} onChange={(id, value) => save({ fairUsage: { [id]: value } })} />
        </>
      )}
    </section>
  );
}
