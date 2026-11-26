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
  BRICK_LIMITS_RECOMMENDED,
  FAIR_USAGE_RECOMMENDED,
  FAIR_USAGE_WINDOW_HOURS,
  FILE_LIMITS_RECOMMENDED,
  LIMIT_RANGES,
  REPLY_LIMITS_RECOMMENDED,
  replyLimitsProblem,
  type ArtifactLimits,
  type BrickLimits,
  type FairUsage,
  type FileLimits,
  type Range,
  type ReplyLimits,
  type ServerLimits,
} from '@/lib/bot-limit-values';
import { VOICE_LIMITS_RECOMMENDED, VOICE_RANGES, textReserve, type VoiceKeyLimitName, type VoiceKeyLimitValues, type VoiceLimits } from '@/lib/voice-limit-values';

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
  /** Nothing is set yet and no value is suggested (game #1999: a computer's money comes from our own test): the row says "Not set", with no recommended mark. */
  unset?: boolean;
  /** Shown under the choices in the sheet: cost or what it affects. */
  note?: string;
  /** No "Other" box (a choice between fixed steps). */
  fixedSteps?: boolean;
  /** A row that may be left empty on purpose: a card to empty it is offered, and choosing it hands -1 to the saver (which saves "empty"). */
  clearable?: { label: string; meaning: string };
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
  if (limit.unset && value === limit.value) return 'Not set';
  const option = limit.options.find((entry) => entry.value === value);
  if (option) return option.label;
  // Money reads as dollars and a share as a percent, not as "0.5 dollars"
  if (limit.unit === 'dollars') return `$${value.toLocaleString('en', { maximumFractionDigits: 6 })}`;
  if (limit.unit === 'percent') return `${value.toLocaleString('en', { maximumFractionDigits: 2 })}%`;
  return `${value.toLocaleString('en')} ${limit.unit}`;
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
  // A limit with no recommended value (a negative one) shows its value alone, and "Not set" while nothing is set
  const mark = limit.unset || limit.recommended < 0 ? null : isRecommended ? <RecommendedPill /> : <span className="text-[11px] text-muted-foreground">Recommended: {shown(limit, limit.recommended)}</span>;
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
          {mark}
        </span>
      </span>
      <span className="hidden shrink-0 justify-items-end gap-1 sm:grid">
        <span className="text-sm font-bold">{shown(limit)}</span>
        {mark}
      </span>
      <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-muted-foreground" />
    </button>
  );
}

/** The choices for one limit: radio cards with what each means, the recommended one marked, and Other. */
export function LimitChoices({ limit, onDone, onCancel }: { limit: Limit; onDone: (value: number) => Promise<void> | void; onCancel: () => void }) {
  const known = !limit.unset && limit.options.some((option) => option.value === limit.value);
  const [picked, setPicked] = useState<number | 'other' | 'clear'>(limit.unset && limit.clearable ? 'clear' : known ? limit.value : 'other');
  const [other, setOther] = useState(known || limit.unset ? '' : String(limit.value));
  const [saving, setSaving] = useState(false);
  // What was typed is read as it is, with commas and spaces as thousands marks: "-50" or "1e2" is refused, not turned into 50 or 12
  const typed = other.replace(/[,\s]/g, '');
  const value = picked === 'clear' ? -1 : picked === 'other' ? (typed === '' ? 0 : /^\d+(\.\d+)?$/.test(typed) ? Number(typed) : Number.NaN) : picked;
  const range = limit.range;
  // A row that can't go above another says the lower of the two as its most
  const most = range ? Math.min(range.max, limit.atMost?.value ?? range.max) : 0;
  const rangeLine = range ? `Between ${range.min.toLocaleString('en')} and ${most.toLocaleString('en')} ${limit.unit}.` : null;
  const outOfRange = picked === 'other' && other.trim() !== '' && !!range && (Number.isNaN(value) || value < range.min || value > range.max || (!!range.whole && !Number.isInteger(value)));
  const aboveOther = !!limit.atMost && value > limit.atMost.value;
  // "Never" (0) is a choice of its own; an empty "Other" is never a choice, and a typed 0 is one only on a row whose range starts at 0
  const zeroAllowed = !!range && range.min <= 0;
  const ready = (picked === 'other' ? typed !== '' && !Number.isNaN(value) && (value > 0 || (zeroAllowed && value === 0)) : true) && !outOfRange && !aboveOther;
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
        {limit.clearable && (
          <PickCard role="radio" picked={picked === 'clear'} onClick={() => setPicked('clear')} indicator={<Radio checked={picked === 'clear'} />} title={limit.clearable.label} description={limit.clearable.meaning} />
        )}
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
      hint: 'How many times a bot may use an app before it answers: searching, reading, building.',
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

/**
 * Limits for Bricks. A person's own Bricks (game #1996): how long a deleted one can be brought back, and when a Brick
 * suggests another. The Brick for guests (game #1997): its own allowance, apart from the replies a guest gets from a
 * host's bots, so a guest who talks to it can still talk to a host's bots as much as before.
 */
export function brickLimits(values: BrickLimits): Limit[] {
  const recommended = BRICK_LIMITS_RECOMMENDED;
  return withRanges([
    {
      id: 'undoDays',
      label: 'Days a deleted Brick can be brought back',
      hint: 'Its chat, what it remembers and its files wait this long, then go for good.',
      unit: 'days',
      value: values.undoDays,
      recommended: recommended.undoDays,
      note: 'A change counts for Bricks deleted from now on. A Brick already deleted keeps the day it was given.',
      options: [
        { value: 3, label: '3 days', meaning: 'then gone for good' },
        { value: 7, label: '7 days', meaning: 'then gone for good' },
        { value: 14, label: '14 days', meaning: 'then gone for good' },
      ],
    },
    {
      id: 'offerAfter',
      label: 'Times a job comes back before Brick suggests a Brick for it',
      hint: 'Brick answers first. When the same kind of job has come back this often, it suggests a Brick just for it, once per topic.',
      unit: 'times',
      value: values.offerAfter,
      recommended: recommended.offerAfter,
      options: [
        { value: 3, label: '3 times', meaning: 'Suggests it early.' },
        { value: 5, label: '5 times', meaning: 'Waits a little longer.' },
        { value: 10, label: '10 times', meaning: 'Only for a job that comes back a lot.' },
      ],
    },
    {
      id: 'guestReplies',
      label: 'Replies for a guest from the Brick for guests',
      hint: `Its own allowance, every ${FAIR_USAGE_WINDOW_HOURS} hours. Replies from a host’s bots don’t use it.`,
      unit: 'replies',
      value: values.guestReplies,
      recommended: recommended.guestReplies,
      options: [
        { value: 10, label: '10 replies', meaning: every },
        { value: 20, label: '20 replies', meaning: every },
      ],
    },
    {
      id: 'universePool',
      label: 'Replies for all guests from the Brick for guests, in one universe',
      hint: `Shared by every guest in that universe, every ${FAIR_USAGE_WINDOW_HOURS} hours. Nothing comes from a host.`,
      unit: 'replies',
      value: values.universePool,
      recommended: recommended.universePool,
      options: [
        { value: 200, label: '200 replies', meaning: every },
        { value: 500, label: '500 replies', meaning: every },
      ],
    },
    {
      id: 'visitEndsMinutes',
      label: 'Minutes a visiting Brick stays after its person is gone',
      hint: 'A Brick that walks with someone goes when they leave Universe. This is how long Universe waits without seeing them before it ends the visit.',
      unit: 'minutes',
      value: values.visitEndsMinutes,
      recommended: recommended.visitEndsMinutes,
      options: [
        { value: 5, label: '5 minutes', meaning: 'It goes quickly.' },
        { value: 10, label: '10 minutes', meaning: 'Survives a short break.' },
        { value: 30, label: '30 minutes', meaning: 'Waits for a longer break.' },
      ],
    },
    {
      id: 'metExpiresDays',
      label: 'Days someone who only met a Brick can still start a message to it',
      hint: 'Meeting a Brick, in a place it visits or lives in, lets a person message it afterwards, wherever it is. Once they have written to it, that stays until its owner or a host changes it, whatever this says.',
      unit: 'days',
      value: values.metExpiresDays,
      recommended: recommended.metExpiresDays,
      options: [
        { value: 7, label: '7 days', meaning: 'Only a fresh meeting counts.' },
        { value: 30, label: '30 days', meaning: 'A month to write back.' },
        { value: 90, label: '90 days', meaning: 'A season to write back.' },
      ],
    },
    {
      id: 'itemsPerPerson',
      label: 'Goals and tasks one person can have going',
      hint: 'Reminders, schedules, watches and goals together, paused ones included. Done ones do not count.',
      unit: 'goals and tasks',
      value: values.itemsPerPerson,
      recommended: recommended.itemsPerPerson,
      options: [
        { value: 10, label: '10', meaning: 'Keeps it small.' },
        { value: 20, label: '20', meaning: 'Room for a good few.' },
        { value: 50, label: '50', meaning: 'For people who keep a lot going.' },
      ],
    },
    {
      id: 'shortestRepeat',
      label: 'Shortest wait between two runs of one goal or task',
      hint: 'A Brick that is asked to check more often says so and offers this instead.',
      unit: 'minutes',
      value: values.shortestRepeat,
      recommended: recommended.shortestRepeat,
      options: [
        { value: 15, label: '15 minutes', meaning: 'Checks often.' },
        { value: 30, label: '30 minutes', meaning: 'A steady pace.' },
        { value: 60, label: '1 hour', meaning: 'Gentle on usage.' },
      ],
    },
    {
      id: 'runsPerDay',
      label: 'Runs a day for one person’s goals and tasks',
      hint: 'Watches, schedules and goals together. Reminders are fixed text with no AI, so they never use these.',
      unit: 'runs',
      value: values.runsPerDay,
      recommended: recommended.runsPerDay,
      options: [
        { value: 12, label: '12 runs', meaning: 'Each day.' },
        { value: 24, label: '24 runs', meaning: 'Each day.' },
        { value: 48, label: '48 runs', meaning: 'Each day.' },
      ],
    },
    {
      id: 'longestRun',
      label: 'Longest one run can take',
      hint: 'After this the run is given up, shown as failed, and the next one starts fresh.',
      unit: 'minutes',
      value: values.longestRun,
      recommended: recommended.longestRun,
      options: [
        { value: 5, label: '5 minutes', meaning: 'For short checks.' },
        { value: 10, label: '10 minutes', meaning: 'A steady pace.' },
        { value: 30, label: '30 minutes', meaning: 'For longer work.' },
      ],
    },
    {
      id: 'computerWait',
      label: 'How long a computer waits for a person to take over',
      hint: 'When Brick hands over and nobody takes over, the computer waits this long. Then the job ends and its room goes back to the person’s allowance.',
      unit: 'minutes',
      value: values.computerWait,
      recommended: recommended.computerWait,
      note: 'Applies to jobs already waiting. Jobs past the new limit end on the next check. Once a person has taken over, the job is theirs and is not ended by this.',
      options: [
        { value: 30, label: '30 minutes', meaning: 'Frees the room sooner.' },
        { value: 60, label: '1 hour', meaning: 'Time to come back to it.' },
        { value: 120, label: '2 hours', meaning: 'For people who step away.' },
      ],
    },
    {
      id: 'coldStorageDays',
      label: 'Days a computer sits unused before it is packed away',
      hint: 'A Brick’s computer that nobody has used for this long is packed into our own encrypted storage, tried out on a throwaway computer, and only then deleted. Its files, its Files list and its chat stay as they are. The next job that needs it brings it back first, which takes a few minutes.',
      unit: 'days',
      value: values.coldStorageDays,
      recommended: recommended.coldStorageDays,
      note: 'Applies from the next check. A computer already packed away stays packed until it is next used.',
      options: [
        { value: 7, label: '7 days', meaning: 'Saves the most; a return after a quiet week takes a few minutes.' },
        { value: 14, label: '14 days', meaning: 'A steady pace.' },
        { value: 30, label: '30 days', meaning: 'Keeps computers ready for longer.' },
      ],
    },
    {
      id: 'pausedSignInsHours',
      label: 'How long a paused computer job keeps its sign-ins',
      hint: 'A paused job keeps the sites it was signed in to and the pages it had open, locked away from every other job, so it carries on where it was. After this long they are dropped: the job stays paused, and it signs in again when it carries on.',
      unit: 'hours',
      value: values.pausedSignInsHours,
      recommended: recommended.pausedSignInsHours,
      note: 'Applies from the next check, to jobs already paused too.',
      options: [
        { value: 4, label: '4 hours', meaning: 'Keeps sign-ins for the shortest time.' },
        { value: 24, label: '1 day', meaning: 'Time to come back to it.' },
        { value: 72, label: '3 days', meaning: 'For people who step away.' },
      ],
    },
    {
      id: 'computerSteps',
      label: 'Steps of a computer job kept for its Activity',
      hint: 'Activity lists what a computer job has done so far, step by step, beside Watch and Files. A job that takes more steps than this keeps the newest ones.',
      unit: 'steps',
      value: values.computerSteps,
      recommended: recommended.computerSteps,
      note: 'Applies from the next step a job takes.',
      options: [
        { value: 50, label: '50 steps', meaning: 'Enough for short jobs.' },
        { value: 200, label: '200 steps', meaning: 'A steady pace.' },
        { value: 1000, label: '1,000 steps', meaning: 'For long jobs.' },
      ],
    },
    {
      id: 'newPerHour',
      label: 'New Bricks one person can make in an hour',
      hint: 'New Brick, Create Brick from a template and asking a Brick in chat all count together. The Brick everyone gets first does not. It only stops a script from making hundreds; a person who goes over is told, kindly, the time they can make another.',
      unit: 'Bricks',
      value: values.newPerHour,
      recommended: recommended.newPerHour,
      note: 'Applies to the next Brick made. Deleted Bricks still count for the hour. A person’s own keys are never limited by this.',
      options: [
        { value: 15, label: '15 Bricks', meaning: 'Quiet.' },
        { value: 30, label: '30 Bricks', meaning: 'The agreed starting value.' },
        { value: 100, label: '100 Bricks', meaning: 'For busy launches.' },
      ],
    },
    {
      id: 'scheduledCardWait',
      label: 'How long a card from a goal or task waits for a person',
      hint: 'When a goal or task needs a yes before it goes on, its card waits this long. If it is the same thing again on a later check, that check joins the waiting card: no second card, no second message. When the time is up the card ends.',
      unit: 'minutes',
      value: values.scheduledCardWait,
      recommended: recommended.scheduledCardWait,
      note: 'Applies to cards from now on. A card already waiting keeps the time it had. A card in chat has its own wait.',
      options: [
        { value: 240, label: '4 hours', meaning: 'Gone by the end of the day.' },
        { value: 1440, label: '1 day', meaning: 'Time to come back to it.' },
        { value: 4320, label: '3 days', meaning: 'For people who step away.' },
      ],
    },
    {
      id: 'snooze',
      label: 'How long Snooze moves a reminder',
      hint: 'Tap Snooze on a reminder or briefing and it comes back this much later.',
      unit: 'minutes',
      value: values.snooze,
      recommended: recommended.snooze,
      options: [
        { value: 15, label: '15 minutes', meaning: 'A short nudge.' },
        { value: 60, label: '1 hour', meaning: 'A steady pace.' },
        { value: 180, label: '3 hours', meaning: 'Well out of the way.' },
      ],
    },
    {
      id: 'failuresBeforeTelling',
      label: 'Failed checks in a row before Brick tells the person',
      hint: 'For a watch or a goal. A reminder or a briefing that fails always tells the person the first time.',
      unit: 'times',
      value: values.failuresBeforeTelling,
      recommended: recommended.failuresBeforeTelling,
      options: [
        { value: 2, label: '2 times', meaning: 'Tells early.' },
        { value: 3, label: '3 times', meaning: 'A steady pace.' },
        { value: 5, label: '5 times', meaning: 'Only when it keeps failing.' },
      ],
    },
    {
      id: 'goalsShare',
      label: 'Share of a person’s usage that goals and tasks may use',
      hint: `Out of the Universe AI usage a signed-in person gets every ${FAIR_USAGE_WINDOW_HOURS} hours. Watches, briefings and goals stop here, so chat always keeps room. A Brick on its owner’s own key never uses it.`,
      unit: '%',
      value: values.goalsShare,
      recommended: recommended.goalsShare,
      note: 'When it is used up they wait with their work saved and carry on when it is back. Reminders are fixed text and always come.',
      options: [
        { value: 20, label: '20%', meaning: 'Chat keeps most of it.' },
        { value: 30, label: '30%', meaning: 'A steady balance.' },
        { value: 50, label: '50%', meaning: 'Half for goals and tasks.' },
      ],
    },
    {
      id: 'keyFormMinutes',
      label: 'How long the safe form for a key stays open',
      hint: 'A Brick or a person asks for a key, and the form opens. After this time it is asked for again, so an old link in a chat cannot be used.',
      unit: 'minutes',
      value: values.keyFormMinutes,
      recommended: recommended.keyFormMinutes,
      options: [
        { value: 15, label: '15 minutes', meaning: 'Short and tight.' },
        { value: 30, label: '30 minutes', meaning: 'Time to find the key.' },
        { value: 60, label: '1 hour', meaning: 'For slow sign-ins at the service.' },
      ],
    },
    {
      id: 'keyTries',
      label: 'Tries for a key in one safe form',
      hint: 'A key the service does not accept counts as a try. After the last one the form is asked for again.',
      unit: 'tries',
      value: values.keyTries,
      recommended: recommended.keyTries,
      options: [
        { value: 3, label: '3 tries', meaning: 'Tight.' },
        { value: 5, label: '5 tries', meaning: 'Room for a typo or two.' },
        { value: 10, label: '10 tries', meaning: 'Loose.' },
      ],
    },
    {
      id: 'keyCallSeconds',
      label: 'How long a request to an app with a key may take',
      hint: 'Past this the request is given up and the Brick is told the app did not answer.',
      unit: 'seconds',
      value: values.keyCallSeconds,
      recommended: recommended.keyCallSeconds,
      options: [
        { value: 10, label: '10 seconds', meaning: 'Quick services only.' },
        { value: 20, label: '20 seconds', meaning: 'A steady wait.' },
        { value: 60, label: '1 minute', meaning: 'For slow services.' },
      ],
    },
    {
      id: 'keyAnswerKb',
      label: 'How much of an app’s answer is read',
      hint: 'Only the fields the app’s definition lists come back, from at most this much of the answer.',
      unit: 'KB',
      value: values.keyAnswerKb,
      recommended: recommended.keyAnswerKb,
      options: [
        { value: 64, label: '64 KB', meaning: 'Small answers.' },
        { value: 256, label: '256 KB', meaning: 'Most answers.' },
        { value: 1024, label: '1 MB', meaning: 'Large lists.' },
      ],
    },
    {
      id: 'keyCallsPerPerson',
      label: 'Requests to apps with a key, for each person, an hour',
      hint: 'All of one person’s Bricks together. When it is used up the Brick says the app is busy and tries again later. Reading and making things count the same.',
      unit: 'requests',
      value: values.keyCallsPerPerson,
      recommended: recommended.keyCallsPerPerson,
      options: [
        { value: 120, label: '120 an hour', meaning: 'Steady use.' },
        { value: 300, label: '300 an hour', meaning: 'Room for busy jobs.' },
        { value: 1000, label: '1,000 an hour', meaning: 'For heavy automation.' },
      ],
    },
    {
      id: 'keyCallsPlatform',
      label: 'Requests to apps with a key, for everyone, an hour',
      hint: 'Every Brick together, a ceiling so one busy hour cannot flood the services people connected.',
      unit: 'requests',
      value: values.keyCallsPlatform,
      recommended: recommended.keyCallsPlatform,
      options: [
        { value: 5000, label: '5,000 an hour', meaning: 'A small ceiling.' },
        { value: 20000, label: '20,000 an hour', meaning: 'Plenty for now.' },
        { value: 100000, label: '100,000 an hour', meaning: 'When many people use it.' },
      ],
    },
    {
      id: 'checkoutsPerVisitor',
      label: 'Checkouts one visitor can start on a page, an hour',
      hint: 'One person tapping Pay again and again. Past this the page says to try again later and the owner is told once.',
      unit: 'checkouts',
      value: values.checkoutsPerVisitor,
      recommended: recommended.checkoutsPerVisitor,
      options: [
        { value: 5, label: '5 an hour', meaning: 'Tight.' },
        { value: 10, label: '10 an hour', meaning: 'Room for a few tries.' },
        { value: 30, label: '30 an hour', meaning: 'Loose.' },
      ],
    },
    {
      id: 'checkoutsPerPage',
      label: 'Checkouts a page can start, an hour',
      hint: 'Every visitor of one page together.',
      unit: 'checkouts',
      value: values.checkoutsPerPage,
      recommended: recommended.checkoutsPerPage,
      options: [
        { value: 50, label: '50 an hour', meaning: 'A small shop.' },
        { value: 100, label: '100 an hour', meaning: 'A busy page.' },
        { value: 500, label: '500 an hour', meaning: 'A launch.' },
      ],
    },
    {
      id: 'checkoutsPerOwner',
      label: 'Checkouts all of one person’s pages can start, an hour',
      hint: 'All of a person’s pages together.',
      unit: 'checkouts',
      value: values.checkoutsPerOwner,
      recommended: recommended.checkoutsPerOwner,
      options: [
        { value: 100, label: '100 an hour', meaning: 'A few pages.' },
        { value: 300, label: '300 an hour', meaning: 'Many pages.' },
        { value: 1000, label: '1,000 an hour', meaning: 'A lot of selling.' },
      ],
    },
    {
      id: 'checkoutOpenHours',
      label: 'How long a checkout nobody paid stays open',
      hint: 'After this it is closed as not paid. Services that hold a payment for 24 hours need at least that long.',
      unit: 'hours',
      value: values.checkoutOpenHours,
      recommended: recommended.checkoutOpenHours,
      options: [
        { value: 24, label: '24 hours', meaning: 'A day.' },
        { value: 48, label: '48 hours', meaning: 'Two days.' },
        { value: 72, label: '72 hours', meaning: 'Three days.' },
      ],
    },
    {
      id: 'latePaymentHours',
      label: 'How long a late payment is still counted',
      hint: 'A buyer may pay at the service after the checkout was closed as not paid. Until this many hours later it is still asked about, and counted if it completes for the right amount.',
      unit: 'hours',
      value: values.latePaymentHours,
      recommended: recommended.latePaymentHours,
      options: [
        { value: 24, label: '24 hours', meaning: 'A day.' },
        { value: 72, label: '72 hours', meaning: 'Three days.' },
        { value: 168, label: '168 hours', meaning: 'A week.' },
      ],
    },
    {
      id: 'paymentCheckSeconds',
      label: 'Wait between two asks about the same payment',
      hint: 'The service is left alone this long before it is asked again about one payment.',
      unit: 'seconds',
      value: values.paymentCheckSeconds,
      recommended: recommended.paymentCheckSeconds,
      options: [
        { value: 3, label: '3 seconds', meaning: 'Quick.' },
        { value: 5, label: '5 seconds', meaning: 'A steady pace.' },
        { value: 15, label: '15 seconds', meaning: 'Gentle on the service.' },
      ],
    },
    {
      id: 'paymentLooksPerOwner',
      label: 'Asks about payments an hour, for each owner',
      hint: 'However many pages and buyers one owner has, their payment service is asked about payments at most this often an hour. It does not use up what Bricks may do with a key.',
      unit: 'asks',
      value: values.paymentLooksPerOwner,
      recommended: recommended.paymentLooksPerOwner,
      options: [
        { value: 500, label: '500 an hour', meaning: 'A small shop.' },
        { value: 2000, label: '2,000 an hour', meaning: 'A busy shop.' },
        { value: 10000, label: '10,000 an hour', meaning: 'Many shops at once.' },
      ],
    },
    {
      id: 'appsPerBot',
      label: 'Apps one bot or Brick can use',
      hint: 'Apps added by hand and Apps lent to a universe count together. A bot that is full says so and asks for one to be taken off first.',
      unit: 'apps',
      value: values.appsPerBot,
      recommended: recommended.appsPerBot,
      options: [
        { value: 5, label: '5 apps', meaning: 'Plenty for most bots.' },
        { value: 10, label: '10 apps', meaning: 'For bots that do a lot.' },
        { value: 20, label: '20 apps', meaning: 'For the busiest bots.' },
      ],
    },
    {
      id: 'sharedUsesEveryone',
      label: 'Uses a day of a shared app, for everyone together',
      hint: 'When a person lets other people ask their Brick for a job from an app, this is where they start: uses a day for everyone together. They can change it for their own app. A try that failed gives its use back; the owner’s own chats never count.',
      unit: 'uses',
      value: values.sharedUsesEveryone,
      recommended: recommended.sharedUsesEveryone,
      note: 'Applies to apps shared from now on. An app already shared keeps what its owner set.',
      options: [
        { value: 10, label: '10 uses', meaning: 'A small trial.' },
        { value: 20, label: '20 uses', meaning: 'A steady start.' },
        { value: 100, label: '100 uses', meaning: 'For apps that cost little.' },
      ],
    },
    {
      id: 'sharedUsesPerPerson',
      label: 'Uses a day of a shared app, for each person',
      hint: 'Where a person’s shared app starts for each person who asks: uses a day. Guests count by their session, so the limit for everyone together is what holds when a guest starts a new one.',
      unit: 'uses',
      value: values.sharedUsesPerPerson,
      recommended: recommended.sharedUsesPerPerson,
      note: 'Applies to apps shared from now on.',
      options: [
        { value: 1, label: '1 use', meaning: 'One try each.' },
        { value: 3, label: '3 uses', meaning: 'A steady start.' },
        { value: 10, label: '10 uses', meaning: 'For friends and regulars.' },
      ],
    },
    {
      id: 'sharedTriesPerHour',
      label: 'Tries an hour at one shared app',
      hint: 'A quiet ceiling beside the daily uses. Every try counts here, also one that failed and gave its use back, so endless failures cannot drain an owner’s account without showing.',
      unit: 'tries',
      value: values.sharedTriesPerHour,
      recommended: recommended.sharedTriesPerHour,
      options: [
        { value: 30, label: '30 tries', meaning: 'Quiet.' },
        { value: 60, label: '60 tries', meaning: 'A steady ceiling.' },
        { value: 200, label: '200 tries', meaning: 'For busy places.' },
      ],
    },
    {
      id: 'sharedRetries',
      label: 'Times one ask may come again',
      hint: 'A retry never runs the job a second time. This is how many times the same ask may be repeated before it is turned away.',
      unit: 'times',
      value: values.sharedRetries,
      recommended: recommended.sharedRetries,
      options: [
        { value: 0, label: 'Never', meaning: 'A repeat is turned away at once.' },
        { value: 2, label: '2 times', meaning: 'A steady ceiling.' },
        { value: 5, label: '5 times', meaning: 'For flaky connections.' },
      ],
    },
    {
      id: 'sharedJobsAtOnce',
      label: 'Jobs at once at one shared app',
      hint: 'How many shared jobs of one app may be running, or waiting to be settled, at the same moment. More wait for a turn: the asker is told to try again soon.',
      unit: 'jobs',
      value: values.sharedJobsAtOnce,
      recommended: recommended.sharedJobsAtOnce,
      options: [
        { value: 1, label: '1 job', meaning: 'One after another.' },
        { value: 3, label: '3 jobs', meaning: 'A steady ceiling.' },
        { value: 10, label: '10 jobs', meaning: 'For apps that handle many.' },
      ],
    },
    {
      id: 'sharedJobMinutes',
      label: 'How long a shared job may run before it stops counting as running',
      hint: 'A job whose result never came back stops holding a place after this long. Its use is not given back: it is only given back once the app confirms it failed.',
      unit: 'minutes',
      value: values.sharedJobMinutes,
      recommended: recommended.sharedJobMinutes,
      options: [
        { value: 5, label: '5 minutes', meaning: 'For quick jobs.' },
        { value: 10, label: '10 minutes', meaning: 'A steady wait.' },
        { value: 30, label: '30 minutes', meaning: 'For long jobs, like a song.' },
      ],
    },
    {
      id: 'templateList',
      label: 'Templates in each short list',
      hint: 'Under “Start from a template” a person sees three short lists: the ones they starred, a few picked by Universe, and Bricks they have met that share one. This is how many each list shows.',
      unit: 'templates',
      value: values.templateList,
      recommended: recommended.templateList,
      options: [
        { value: 5, label: '5 templates', meaning: 'Very short lists.' },
        { value: 10, label: '10 templates', meaning: 'Short and easy to scan.' },
        { value: 20, label: '20 templates', meaning: 'For a busy shelf.' },
      ],
    },
    {
      id: 'computerFiles',
      label: 'Files a finished computer job hands over',
      hint: 'When a job on a Brick’s computer finishes, Brick puts the files it made in the chat as cards, newest first. This is how many. Any others are named in the message and stay on the computer. 0 hands over none.',
      unit: 'files',
      value: values.computerFiles,
      recommended: recommended.computerFiles,
      options: [
        { value: 1, label: '1 file', meaning: 'Only the newest.' },
        { value: 5, label: '5 files', meaning: 'Enough for most jobs.' },
        { value: 10, label: '10 files', meaning: 'For jobs that make a few.' },
      ],
    },
    {
      id: 'computerFileMb',
      label: 'Largest file a computer job hands over',
      hint: 'A file bigger than this is not copied into the chat. Brick names it in the message and it stays on the computer. Every file handed over is kept in Universe in Files, so this also limits storage. The chat takes up to 50 MB.',
      unit: 'megabytes',
      value: values.computerFileMb,
      recommended: recommended.computerFileMb,
      options: [
        { value: 10, label: '10 MB', meaning: 'Documents and pictures.' },
        { value: 25, label: '25 MB', meaning: 'Most receipts, reports and slides.' },
        { value: 50, label: '50 MB', meaning: 'The most the chat takes; slower to hand over.' },
      ],
    },
  ], LIMIT_RANGES.bricks);
}

/**
 * The first row of Limits, Bricks (game #1999): the computer allowance for each member, a month. Every member starts with it, so
 * nothing is switched on per person. It has no suggested value: the starting value comes from our own test on the dev server, so
 * until a super admin sets it the row says "Not set" and Bricks' computers stay closed. Shown in dollars; kept in millionths.
 */
export const COMPUTER_ALLOWANCE_ID = 'computerMonth';
export const dollarsToMicros = (dollars: number) => Math.round(dollars * 1_000_000);

export function computerAllowanceLimit(micros: number | null): Limit {
  const month = 'a month, for each member';
  return {
    id: COMPUTER_ALLOWANCE_ID,
    label: 'Computer allowance for each member, a month',
    hint: 'What a member’s Bricks can use on computers in a month. When it runs out, Brick offers “Ask for more”. Chat and voice keep the fair usage above.',
    unit: 'dollars',
    value: micros === null ? 0 : micros / 1_000_000,
    recommended: -1,
    unset: micros === null,
    options: [
      { value: 3, label: '$3', meaning: month },
      { value: 5, label: '$5', meaning: month },
      { value: 10, label: '$10', meaning: month },
    ],
    note: micros === null ? 'Not set yet. Brick computers stay closed until it is. The starting value comes from our own test on the dev server.' : undefined,
    range: { min: 0.01, max: 1_000_000 },
  };
}

/**
 * What Universe is ready to fund from grants (spec v3 section 16, O3): kept in the meter's settings, in millionths of a dollar. It
 * has no suggested value: until a super admin sets it, the row says "Not set" and nothing is assumed.
 */
export const ROLLOUT_BUDGET_ID = 'rolloutBudget';
export type MoneyLimitSettings = { rolloutBudgetMicros?: number | null };

export function moneyLimits(settings: MoneyLimitSettings): Limit[] {
  const micros = settings.rolloutBudgetMicros ?? null;
  return [
    {
      id: ROLLOUT_BUDGET_ID,
      label: 'Rollout budget for grants',
      hint: 'The most credit Universe is ready to fund from defaults and gifts. A default stops reaching new people when it would go past this.',
      unit: 'dollars',
      value: micros === null ? 0 : micros / 1_000_000,
      recommended: -1,
      unset: micros === null,
      options: [],
      note: micros === null ? 'Not set yet. Nothing is assumed: set it before the first default reaches anyone.' : undefined,
      range: { min: 0.01, max: 1_000_000 },
    },
  ];
}

/**
 * The Instant Apps limits (spec v3 O2/O3): read from /api/admin/instant, which says each limit's words, range and value. Money is held in
 * millionths of a dollar and shown in dollars; shares are held in hundredths of a percent and shown as a percent. Nothing is built in here.
 */
export type InstantLimitView = {
  value: number | null;
  range: { min: number; max: number };
  recommended: number | null;
  label: string;
  hint: string;
  unit: 'micros' | 'bps' | 'count' | 'minutes';
  required: boolean;
};
export type InstantLimitViews = Record<string, InstantLimitView>;

const INSTANT_COUNT_WORDS: Record<string, string> = { pauseMinRuns: 'runs', goodwillPerPersonPerMonth: 'give-backs', maxRunsPerQuestion: 'runs' };
const instantScale = (unit: InstantLimitView['unit']) => (unit === 'micros' ? 1_000_000 : unit === 'bps' ? 100 : 1);
const instantUnit = (key: string, unit: InstantLimitView['unit']) => (unit === 'micros' ? 'dollars' : unit === 'bps' ? 'percent' : unit === 'minutes' ? 'minutes' : (INSTANT_COUNT_WORDS[key] ?? 'times'));

/** The limits of an answer from /api/admin/instant, or null when it is not that answer (each one needs its words and range). */
export function readInstantLimits(answer: unknown): InstantLimitViews | null {
  const limits = (answer as { limits?: unknown } | null)?.limits;
  if (!limits || typeof limits !== 'object') return null;
  const entries = Object.entries(limits as Record<string, Partial<InstantLimitView>>);
  // Every field a row is drawn from is checked: a row without its value, its recommendation or whether it is required would come out as NaN
  const numberOrNull = (field: unknown) => field === null || (typeof field === 'number' && Number.isFinite(field));
  const valid = entries.length > 0 && entries.every(([, view]) => view && typeof view.label === 'string' && typeof view.hint === 'string' && view.range && typeof view.range.min === 'number' && typeof view.range.max === 'number' && ['micros', 'bps', 'count', 'minutes'].includes(view.unit as string) && numberOrNull(view.value) && numberOrNull(view.recommended) && typeof view.required === 'boolean');
  return valid ? (limits as InstantLimitViews) : null;
}

export function instantLimits(views: InstantLimitViews): Limit[] {
  return Object.entries(views).map(([key, view]) => {
    const scale = instantScale(view.unit);
    const unset = view.value === null;
    return {
      id: key,
      label: view.label,
      hint: view.hint,
      unit: instantUnit(key, view.unit),
      value: unset ? 0 : (view.value as number) / scale,
      recommended: view.recommended === null ? -1 : view.recommended / scale,
      unset,
      options: [],
      note: unset ? (view.required ? 'Not set yet. Instant Apps do not run until you set it.' : 'Not set yet.') : undefined,
      range: { min: view.range.min / scale, max: view.range.max / scale },
    };
  });
}


/**
 * The code job limits for Apps (the bounded Workbench): read from /api/admin/workbench, which says each limit's words, range and value.
 * Sizes are held in bytes and shown in MB (the code itself in KB), money in millionths of a dollar and shown in dollars. Nothing is built in here.
 */
export type CodeJobLimitView = {
  value: number | null;
  range: { min: number; max: number };
  recommended: number | null;
  label: string;
  help: string;
  unit: 'seconds' | 'count' | 'bytes' | 'micros' | 'days';
  required: boolean;
};
export type CodeJobLimitViews = Record<string, CodeJobLimitView>;

const CODE_JOB_COUNT_WORDS: Record<string, string> = { maxCells: 'runs', maxOutputFiles: 'files', maxResultChars: 'characters', maxReads: 'reads', atOncePerPerson: 'jobs', atOnceAll: 'jobs', jobsPerPersonPerDay: 'jobs' };
const codeJobScale = (key: string, unit: CodeJobLimitView['unit']) => (unit === 'micros' ? 1_000_000 : unit === 'bytes' ? (key === 'maxCodeBytes' || key === 'maxAnswerBytes' ? 1024 : 1_048_576) : 1);
const codeJobUnit = (key: string, unit: CodeJobLimitView['unit']) => (unit === 'micros' ? 'dollars' : unit === 'bytes' ? (key === 'maxCodeBytes' || key === 'maxAnswerBytes' ? 'KB' : 'MB') : unit === 'count' ? (CODE_JOB_COUNT_WORDS[key] ?? 'times') : unit);

/** The limits of an answer from /api/admin/workbench, or null when it is not that answer (each one needs its words and range). */
export function readCodeJobLimits(answer: unknown): CodeJobLimitViews | null {
  const limits = (answer as { limits?: unknown } | null)?.limits;
  if (!limits || typeof limits !== 'object') return null;
  const entries = Object.entries(limits as Record<string, Partial<CodeJobLimitView>>);
  const valid = entries.length > 0 && entries.every(([, view]) => view && typeof view.label === 'string' && typeof view.help === 'string' && view.range && typeof view.range.min === 'number' && typeof view.range.max === 'number' && ['seconds', 'count', 'bytes', 'micros', 'days'].includes(view.unit as string));
  return valid ? (limits as CodeJobLimitViews) : null;
}

export function codeJobLimits(views: CodeJobLimitViews): Limit[] {
  return Object.entries(views).map(([key, view]) => {
    const scale = codeJobScale(key, view.unit);
    const unset = view.value === null;
    return {
      id: key,
      label: view.label,
      hint: view.help,
      unit: codeJobUnit(key, view.unit),
      value: unset ? 0 : (view.value as number) / scale,
      recommended: view.recommended === null ? -1 : view.recommended / scale,
      unset,
      options: [],
      note: unset ? (view.required ? 'Not set yet. Code jobs do not run until you set it.' : key === 'maxAnswerBytes' ? 'Not set yet. Every App answer is passed on whole.' : 'Not set yet. Printed results are kept until the person deletes them.') : undefined,
      range: { min: view.range.min / scale, max: view.range.max / scale },
      // The two that may be empty on purpose can be emptied again from here
      ...(CODE_JOB_EMPTYABLE[key] ? { clearable: CODE_JOB_EMPTYABLE[key] } : {}),
    };
  });
}

/** The code job Limits that may be left empty, and what empty means for each. */
const CODE_JOB_EMPTYABLE: Record<string, { label: string; meaning: string } | undefined> = {
  keepDays: { label: 'Not set', meaning: 'Printed results are kept until the person deletes them.' },
  maxAnswerBytes: { label: 'Not set', meaning: 'Every App answer is passed on whole, whatever its size.' },
};

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

/** "30 seconds", "1 minute", "3 minutes"; a value that is not a whole minute stays in seconds. */
function secondsLabel(value: number): string {
  if (value >= 60 && value % 60 === 0) return `${value / 60} ${value === 60 ? 'minute' : 'minutes'}`;
  return `${value.toLocaleString('en')} ${value === 1 ? 'second' : 'seconds'}`;
}

const charactersLabel = (value: number) => `${value.toLocaleString('en')} characters`;
const minutesLabel = (value: number) => `${value.toLocaleString('en')} ${value === 1 ? 'minute' : 'minutes'}`;

/**
 * The steps offered for one voice limit, with the server's own value among them marked Recommended: it is whatever a super admin
 * set, so it is added when it isn't one of the steps, never typed here.
 */
function voiceOptions(steps: LimitOption[], recommended: number, label: (value: number) => string): LimitOption[] {
  const all = steps.some((step) => step.value === recommended) ? steps : [...steps, { value: recommended, label: label(recommended), meaning: 'What Universe suggests for every key.' }];
  return [...all].sort((a, b) => a.value - b.value);
}

/** A voice key's limits (#783): how long a person may speak, how much a bot says, and how long it listens in a day. Each shows the server's own value as the recommended one. */
export function voiceKeyLimits(values: VoiceKeyLimitValues): Limit[] {
  const rows: (Omit<Limit, 'value' | 'recommended' | 'range' | 'options'> & { id: VoiceKeyLimitName; steps: LimitOption[]; name: (value: number) => string })[] = [
    {
      id: 'turnSeconds',
      label: 'Longest turn',
      hint: 'How long a person can speak to a bot in one go.',
      unit: 'seconds',
      name: secondsLabel,
      steps: [
        { value: 30, label: '30 seconds', meaning: 'A quick question.' },
        { value: 60, label: '1 minute', meaning: 'A short message.' },
        { value: 120, label: '2 minutes', meaning: 'A longer message.' },
        { value: 300, label: '5 minutes', meaning: 'Long explanations. More audio for the key to listen to.' },
      ],
    },
    {
      id: 'replyCharacters',
      label: 'Longest spoken reply',
      hint: 'How much a bot says out loud in one reply.',
      unit: 'characters',
      name: charactersLabel,
      steps: [
        { value: 300, label: '300 characters', meaning: 'A few sentences.' },
        { value: 1000, label: '1,000 characters', meaning: 'A long answer.' },
        { value: 2000, label: '2,000 characters', meaning: 'About a page read aloud.' },
      ],
    },
    {
      id: 'replySeconds',
      label: 'Longest reply in time',
      hint: 'How long a spoken reply may run.',
      unit: 'seconds',
      name: secondsLabel,
      steps: [
        { value: 15, label: '15 seconds', meaning: 'Short answers.' },
        { value: 30, label: '30 seconds', meaning: 'A few sentences.' },
        { value: 120, label: '2 minutes', meaning: 'Long answers.' },
      ],
    },
    {
      id: 'listenMinutesPerDay',
      label: 'Listening a day',
      hint: 'Minutes a day one bot listens for its name, all the people near it together.',
      unit: 'minutes',
      name: minutesLabel,
      steps: [
        { value: 0, label: 'Never', meaning: 'The bot doesn’t listen, so nobody can speak to it.' },
        { value: 15, label: '15 minutes', meaning: 'Now and then.' },
        { value: 30, label: '30 minutes', meaning: 'A quiet room.' },
        { value: 120, label: '2 hours', meaning: 'A busy room.' },
        { value: 240, label: '4 hours', meaning: 'Always on. The key listens the whole time.' },
      ],
    },
  ];
  return rows.map(({ steps, name, ...row }) => ({
    ...row,
    value: values[row.id].value,
    recommended: values[row.id].recommended,
    options: voiceOptions(steps, values[row.id].recommended, name),
    range: { ...VOICE_RANGES[row.id], whole: true },
  }));
}

/** The steps of one voice limit with the value set now among them, so the sheet always opens on a choice that is there. */
function withCurrent(steps: LimitOption[], value: number, label: (value: number) => string): LimitOption[] {
  return steps.some((step) => step.value === value) ? steps : [...steps, { value, label: label(value), meaning: 'What is set now.' }];
}

/**
 * The 8 voice limits a super admin sets for every voice bot (#740, shown under Limits in #792): the four a key's owner can also
 * change on their key, then how long a person can keep talking without the bot's name, the share of replies kept for text and how
 * many voice replies a guest gets. `fair` is the fair usage window the last two are measured in.
 */
export function voiceServerLimits(values: VoiceLimits, fair: { signedIn: number; guest: number }): Limit[] {
  const recommended = VOICE_LIMITS_RECOMMENDED;
  const keyRows = voiceKeyLimits(
    Object.fromEntries((['turnSeconds', 'replyCharacters', 'replySeconds', 'listenMinutesPerDay'] as const).map((name) => [name, { value: values[name], recommended: recommended[name], changed: values[name] !== recommended[name] }])) as VoiceKeyLimitValues
  );
  const oneIn = (value: number) => `1 in ${value}`;
  // What a guest can really get is their replies minus the ones kept for text, the same sum the server does
  const guestVoiceLeft = Math.max(0, Math.floor(fair.guest) - textReserve(fair.guest, values.textReserveShare));
  const fiveGuestReplies = (left: number) => {
    if (left <= 0) return 'Guests get text only.';
    if (left === 1) return 'The only voice reply a guest has.';
    if (left <= 5) return `All ${left} voice replies a guest has.`;
    return `5 of the ${left} voice replies a guest has.`;
  };
  const kept = (share: number) => `${fair.signedIn} replies keep ${textReserve(fair.signedIn, share)} for text.`;
  const own = (id: keyof VoiceLimits, row: Omit<Limit, 'value' | 'recommended' | 'range' | 'options'> & { steps: LimitOption[]; name: (value: number) => string }): Limit => {
    const { steps, name, ...rest } = row;
    return { ...rest, value: values[id], recommended: recommended[id], options: [...withCurrent(voiceOptions(steps, recommended[id], name), values[id], name)].sort((a, b) => a.value - b.value), range: { ...VOICE_RANGES[id], whole: true } };
  };
  return [
    ...keyRows,
    own('followUpSeconds', {
      id: 'followUpSeconds',
      label: 'Keep talking without its name',
      hint: 'After a bot answers, how long the person can carry on without saying its name.',
      unit: 'seconds',
      name: secondsLabel,
      steps: [
        { value: 15, label: '15 seconds', meaning: 'Quick back and forth.' },
        { value: 30, label: '30 seconds', meaning: 'A natural pace.' },
        { value: 60, label: '1 minute', meaning: 'A relaxed chat. The bot listens longer.' },
      ],
    }),
    own('voicesShownFirst', {
      id: 'voicesShownFirst',
      label: 'Voices shown first',
      hint: 'How many voices a maker hears first when they give a bot a voice. The rest are behind “All voices”.',
      unit: 'voices',
      name: (value) => `${value} ${value === 1 ? 'voice' : 'voices'}`,
      steps: [
        { value: 3, label: '3 voices', meaning: 'A short list.' },
        { value: 5, label: '5 voices', meaning: 'Enough to hear a few.' },
        { value: 8, label: '8 voices', meaning: 'A longer list to scroll.' },
      ],
    }),
    own('textReserveShare', {
      id: 'textReserveShare',
      label: 'Replies kept for text',
      hint: `Of each person’s replies in a ${FAIR_USAGE_WINDOW_HOURS}-hour window, about 1 in this many stay for text. ${kept(values.textReserveShare)}`,
      unit: 'replies',
      fixedSteps: true,
      name: oneIn,
      steps: [3, 6, 10].map((share) => ({ value: share, label: oneIn(share), meaning: kept(share) })),
    }),
    own('guestVoiceReplies', {
      id: 'guestVoiceReplies',
      label: 'Voice replies for a guest',
      hint: `Someone who isn’t signed in, every ${FAIR_USAGE_WINDOW_HOURS} hours, from their ${fair.guest} replies.`,
      unit: 'replies',
      name: (value) => (value === 0 ? 'None' : `${value} ${value === 1 ? 'reply' : 'replies'}`),
      steps: [
        { value: 0, label: 'None', meaning: 'Guests get text only.' },
        { value: 1, label: '1 reply', meaning: 'A taste of voice.' },
        { value: 3, label: '3 replies', meaning: 'A short conversation.' },
        { value: 5, label: '5 replies', meaning: fiveGuestReplies(guestVoiceLeft) },
      ],
    }),
    // Voice notes (game: every bot hears voice notes): what Universe AI hears, apart from talking live
    own('longestNoteSeconds', {
      id: 'longestNoteSeconds',
      label: 'Longest voice note',
      hint: 'The longest voice note a bot listens to. A longer one is refused before anything is paid, with “Send a shorter one.”',
      unit: 'seconds',
      name: secondsLabel,
      steps: [
        { value: 60, label: '1 minute', meaning: 'Quick notes only.' },
        { value: 180, label: '3 minutes', meaning: 'Most notes fit.' },
        { value: 300, label: '5 minutes', meaning: 'Room for a long thought.' },
      ],
    }),
    own('noteMinutesPerPerson', {
      id: 'noteMinutesPerPerson',
      label: 'Voice notes heard for a person',
      hint: 'Minutes of voice notes Universe AI hears for one person in a day, from every bot together. A bot on its maker’s own listening key doesn’t count.',
      unit: 'minutes',
      name: (value) => (value === 0 ? 'None' : minutesLabel(value)),
      steps: [
        { value: 10, label: '10 minutes', meaning: 'A few short notes a day.' },
        { value: 30, label: '30 minutes', meaning: 'Plenty for everyday notes.' },
        { value: 60, label: '1 hour', meaning: 'For people who talk more than they type.' },
      ],
    }),
    own('guestNoteMinutesPerGuest', {
      id: 'guestNoteMinutesPerGuest',
      label: 'Voice notes heard for a guest',
      hint: 'Minutes of voice notes the Brick for guests hears for someone who isn’t signed in, in a day.',
      unit: 'minutes',
      name: (value) => (value === 0 ? 'None' : minutesLabel(value)),
      steps: [
        { value: 0, label: 'None', meaning: 'Guests type to the Brick.' },
        { value: 5, label: '5 minutes', meaning: 'A taste of voice notes.' },
        { value: 10, label: '10 minutes', meaning: 'A short conversation.' },
      ],
    }),
    own('guestNoteMinutesPerUniverse', {
      id: 'guestNoteMinutesPerUniverse',
      label: 'Voice notes heard for a universe’s guests',
      hint: 'Minutes of voice notes the Brick for guests hears for all the guests of one universe together, in a day.',
      unit: 'minutes',
      name: (value) => (value === 0 ? 'None' : minutesLabel(value)),
      steps: [
        { value: 60, label: '1 hour', meaning: 'A quiet universe.' },
        { value: 120, label: '2 hours', meaning: 'A busy day of visitors.' },
        { value: 480, label: '8 hours', meaning: 'A very busy universe.' },
      ],
    }),
    own('notesAtOnce', {
      id: 'notesAtOnce',
      label: 'Voice notes heard at once',
      hint: 'How many voice notes Universe AI hears at the same moment, for everyone. One more waits and is told to try again.',
      unit: 'notes',
      name: (value) => `${value} ${value === 1 ? 'note' : 'notes'}`,
      steps: [
        { value: 4, label: '4 notes', meaning: 'A small server.' },
        { value: 8, label: '8 notes', meaning: 'Room for a busy hour.' },
        { value: 20, label: '20 notes', meaning: 'A large server.' },
      ],
    }),
    own('noteMinutesPerHour', {
      id: 'noteMinutesPerHour',
      label: 'Voice notes heard in an hour',
      hint: 'Minutes of voice notes Universe AI hears in an hour, for everyone together. It keeps new guest ids from getting around the limits above.',
      unit: 'minutes',
      name: minutesLabel,
      steps: [
        { value: 120, label: '2 hours', meaning: 'A small server.' },
        { value: 300, label: '5 hours', meaning: 'Room for a busy hour.' },
        { value: 1200, label: '20 hours', meaning: 'A large server.' },
      ],
    }),
  ];
}

/** The voice key card's one line: "Recommended: turns up to 3 minutes, replies up to 600 characters", or "Yours: …" once changed. */
export function voiceKeyLimitsLine(values: VoiceKeyLimitValues): string {
  const rows = voiceKeyLimits(values);
  const changed = rows.some((row) => row.value !== row.recommended);
  return `${changed ? 'Yours' : 'Recommended'}: turns up to ${shown(rows[0])}, replies up to ${shown(rows[1])}`;
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

/** Saves one of a voice key's limits (#783) and answers with all four as saved, or null when it was turned down (and says why). */
export function useSaveVoiceKeyLimit() {
  const { addToast } = useToast();
  return async (keyId: string, id: string, value: number): Promise<VoiceKeyLimitValues | null> => {
    const result = await sendLimits(`/api/me/voice-keys/${encodeURIComponent(keyId)}`, { limits: { [id]: value } });
    if (!result.ok) {
      addToast({ description: result.error, variant: 'error' });
      return null;
    }
    addToast({ description: 'Saved', variant: 'success', duration: 2000 });
    return (result.data as { key: { limits: VoiceKeyLimitValues } }).key.limits;
  };
}

/**
 * The Limits section of the Universe AI page (#666): Universe AI's reply limits, the artifact limits, files in chats,
 * the "Say when nothing was saved" switch and fair usage. Each value is saved as soon as it is picked.
 */
export function UniverseAiLimits() {
  const { addToast } = useToast();
  const [limits, setLimits] = useState<ServerLimits | null>(null);
  const [voice, setVoice] = useState<VoiceLimits | null>(null);
  const [failed, setFailed] = useState(false);
  const [voiceFailed, setVoiceFailed] = useState(false);
  const [savingGuard, setSavingGuard] = useState(false);
  // The meter's computer allowance for each member (game #1999): null until a super admin sets it
  const [allowance, setAllowance] = useState<{ micros: number | null } | null>(null);
  // The money limits live in the same settings (spec v3 O3): what is given back, and how much Universe funds
  const [money, setMoney] = useState<MoneyLimitSettings>({});
  const [allowanceFailed, setAllowanceFailed] = useState(false);
  // Instant Apps' own limits come from their own route; when it is not there (or not readable) the group is simply not shown
  const [instant, setInstant] = useState<InstantLimitViews | null>(null);
  // Code jobs' own limits, the same way
  const [codeJobs, setCodeJobs] = useState<CodeJobLimitViews | null>(null);

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

  // The voice limits are a super admin's too (#792); they are read on their own, so a failure there doesn't hide the others
  async function loadVoice() {
    setVoiceFailed(false);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/voice-limits');
      if (!response.ok) throw new Error('load');
      setVoice(((await response.json()) as { limits: VoiceLimits }).limits);
    } catch {
      setVoiceFailed(true);
    }
  }

  async function loadAllowance() {
    setAllowanceFailed(false);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/meter-settings');
      if (!response.ok) throw new Error('load');
      const { settings } = (await response.json()) as { settings: { memberAllowanceMicros: number | null } & MoneyLimitSettings };
      setAllowance({ micros: settings.memberAllowanceMicros });
      setMoney(settings);
    } catch {
      setAllowanceFailed(true);
    }
  }

  async function loadInstant() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/instant');
      if (!response.ok) return;
      const views = readInstantLimits(await response.json());
      if (views) setInstant(views);
    } catch {
      // Not shown until it can be read
    }
  }

  async function loadCodeJobs() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/workbench');
      if (!response.ok) return;
      const views = readCodeJobLimits(await response.json());
      if (views) setCodeJobs(views);
    } catch {
      // Not shown until it can be read
    }
  }

  useEffect(() => {
    load();
    loadVoice();
    loadAllowance();
    loadInstant();
    loadCodeJobs();
  }, []);

  async function saveAllowance(dollars: number): Promise<boolean> {
    const result = await sendLimits('/api/admin/meter-settings', { memberAllowanceMicros: dollarsToMicros(dollars) });
    if (!result.ok) {
      addToast({ description: result.error, variant: 'error' });
      return false;
    }
    setAllowance({ micros: (result.data as { settings: { memberAllowanceMicros: number | null } }).settings.memberAllowanceMicros });
    addToast({ description: 'Saved', variant: 'success', duration: 2000 });
    return true;
  }

  async function saveMoney(id: string, dollars: number): Promise<boolean> {
    if (id !== ROLLOUT_BUDGET_ID) return false;
    const result = await sendLimits('/api/admin/meter-settings', { rolloutBudgetMicros: dollarsToMicros(dollars) });
    if (!result.ok) {
      addToast({ description: result.error, variant: 'error' });
      return false;
    }
    setMoney((result.data as { settings: MoneyLimitSettings }).settings);
    addToast({ description: 'Saved', variant: 'success', duration: 2000 });
    return true;
  }

  async function saveInstant(id: string, value: number): Promise<boolean> {
    const view = instant?.[id];
    if (!view) return false;
    const result = await sendLimits('/api/admin/instant', { [id]: Math.round(value * instantScale(view.unit)) });
    if (!result.ok) {
      addToast({ description: result.error, variant: 'error' });
      return false;
    }
    const views = readInstantLimits(result.data);
    if (views) setInstant(views);
    addToast({ description: 'Saved', variant: 'success', duration: 2000 });
    return true;
  }

  async function saveCodeJobs(id: string, value: number): Promise<boolean> {
    const view = codeJobs?.[id];
    if (!view) return false;
    // A negative value is the "Not set" card: empty is saved as null
    const result = await sendLimits('/api/admin/workbench', { [id]: value < 0 ? null : Math.round(value * codeJobScale(id, view.unit)) });
    if (!result.ok) {
      addToast({ description: result.error, variant: 'error' });
      return false;
    }
    const views = readCodeJobLimits(result.data);
    if (views) setCodeJobs(views);
    addToast({ description: 'Saved', variant: 'success', duration: 2000 });
    return true;
  }

  async function saveVoice(change: Record<string, unknown>): Promise<boolean> {
    const result = await sendLimits('/api/admin/voice-limits', change);
    if (!result.ok) {
      addToast({ description: result.error, variant: 'error' });
      return false;
    }
    setVoice((result.data as { limits: VoiceLimits }).limits);
    addToast({ description: 'Saved', variant: 'success', duration: 2000 });
    return true;
  }

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
          {allowanceFailed && <LoadError label="the computer allowance" retry={loadAllowance} />}
          <LimitGroup
            title="Bricks"
            note="Every member starts with these, so nothing is switched on per person. The starting values come from our own test on the dev server."
            // The Bricks limits that were read stay when only the allowance could not be read; its row comes in once it is
            limits={[...(allowance ? [computerAllowanceLimit(allowance.micros)] : []), ...brickLimits(limits.bricks)]}
            onChange={(id, value) => (id === COMPUTER_ALLOWANCE_ID ? saveAllowance(value) : save({ bricks: { [id]: value } }))}
          />
          {instant && <LimitGroup title="Instant Apps" note="Apps that work without connecting anything. Universe pays for each run, so each limit is yours to set. Instant Apps do not run until the required ones have a number." limits={instantLimits(instant)} onChange={saveInstant} />}
          {codeJobs && <LimitGroup title="Apps: code jobs" note="Short pieces of code an App's Brick may run in a separate, temporary workspace with no access to anyone's accounts. They are on by default, with these starting values; change any of them here. A job stops at its time and size limits, whatever it was doing." limits={codeJobLimits(codeJobs)} onChange={saveCodeJobs} />}
          {allowance && <LimitGroup title="Credit and give-backs" note="What Universe funds and returns. None of these has a built-in value: set each one yourself." limits={moneyLimits(money)} onChange={saveMoney} />}
          {voiceFailed ? (
            <LoadError label="the voice limits" retry={loadVoice} />
          ) : !voice ? (
            <LoadingRows label="the voice limits" rows={2} />
          ) : (
            <LimitGroup
              title="Voice, for all bots"
              note="People with their own voice key can change the first four on their key."
              limits={voiceServerLimits(voice, limits.fairUsage)}
              onChange={(id, value) => saveVoice({ [id]: value })}
            />
          )}
        </>
      )}
    </section>
  );
}
