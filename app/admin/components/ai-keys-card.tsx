'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowUpRight, KeyRound } from 'lucide-react';
import { kindInfo } from '@/lib/ai-key-kinds';
import type { AiKeySummary } from '@/lib/ai-keys';
import type { VoiceKeySummary } from '@/lib/voice-keys';
import { voiceKeyCompanyInfo } from '@/lib/voice-key-companies';
import { useAiKeys } from '../hooks/use-ai-keys';
import { useVoiceKeys } from '../hooks/use-voice-keys';
import { ProviderLogo } from './ds/provider-logo';

/** The providers the card shows someone with no key yet: what they can bring. */
const SHOWN_KINDS = ['openrouter', 'claude', 'openai', 'gemini', 'deepseek', 'lmstudio'];
/** Keys listed on the card, down ones first; the rest are counted. */
const MAX_SHOWN = 3;

/** Why a key is down, in a few words that start a sentence. */
const DOWN_PHRASE = {
  stopped: 'Stopped answering',
  rejected: 'Didn’t accept the key',
  errors: 'Kept failing',
  credit: 'Out of credit',
  model: 'No longer has the model',
} as const;

const plural = (value: number, one: string, many = `${one}s`) => `${value} ${value === 1 ? one : many}`;

/** "Sam", "Guide and Nora", "Guide, Nora and Sam". */
function names(list: string[]): string {
  return list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** "2:14 PM", or "Oct 18, 2:14 PM" when it was not today, as on the AI keys page. */
function sinceText(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/** A key as the card shows it: a text key or a voice key (#749), told apart only by what its bots do while it is down. */
interface Row {
  id: string;
  name: string;
  logo: Parameters<typeof ProviderLogo>[0]['info'];
  down: boolean;
  downSince: string | null;
  downReason: keyof typeof DOWN_PHRASE | null;
  lentTo: { universeName: string; bots: string[] }[];
  /** What its bots do while it is down, as a sentence that starts with them. */
  whileDown: (bots: string[]) => string;
  /** Replies it paid for this month (voice replies for a voice key). */
  replies: number;
  createdAt: string;
}

const textRow = (key: AiKeySummary): Row => ({
  id: key.id,
  name: key.name,
  logo: key.kind ? kindInfo(key.kind) : undefined,
  down: key.status === 'down',
  downSince: key.downSince,
  downReason: key.downReason,
  lentTo: key.lentTo.map((lent) => ({ universeName: lent.universeName, bots: lent.bots.map((bot) => bot.name) })),
  whileDown: (bots) =>
    key.ifDown === 'stop' ? `${names(bots)} ${bots.length === 1 ? 'rests' : 'rest'} until it’s back.` : `${names(bots)} ${bots.length === 1 ? 'replies' : 'reply'} on Universe AI until it’s back.`,
  replies: key.month.replies,
  createdAt: key.createdAt,
});

const voiceRow = (key: VoiceKeySummary): Row => ({
  id: key.id,
  name: key.name,
  logo: { logo: voiceKeyCompanyInfo(key.adapter)?.logo },
  down: key.health.status === 'down',
  downSince: key.health.downSince,
  downReason: key.health.downReason,
  lentTo: key.lentTo.map((lent) => ({ universeName: lent.universeName, bots: lent.bots.map((bot) => bot.name) })),
  // A voice key has no other voice to move to: bots carry on in text
  whileDown: (bots) => `${names(bots)} ${bots.length === 1 ? 'replies' : 'reply'} in text until it’s back.`,
  replies: key.month.voiceReplies,
  createdAt: key.createdAt,
});

/** The line under a key: what happened and what its bots do meanwhile when it is down, else where it is lent. */
function keyLine(key: Row): string {
  if (key.down) {
    const bots = key.lentTo.flatMap((lent) => lent.bots);
    const meanwhile = bots.length === 0 ? '' : ` ${key.whileDown(bots)}`;
    return `${DOWN_PHRASE[key.downReason ?? 'stopped']} since ${sinceText(key.downSince ?? new Date().toISOString())}.${meanwhile}`;
  }
  if (key.lentTo.length === 0) return 'Not lent to a universe yet';
  const bots = key.lentTo.reduce((total, lent) => total + lent.bots.length, 0);
  const where = key.lentTo.length <= 2 ? `Lent to ${names(key.lentTo.map((lent) => lent.universeName))}` : `Lent to ${key.lentTo.length} universes`;
  return bots > 0 ? `${where} · ${plural(bots, 'bot')}` : where;
}

function Dot({ down }: { down: boolean }) {
  return <i aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${down ? 'bg-[#F5C451]' : 'bg-[#4ade80]'}`} />;
}

/** The card itself: one link to the AI keys page, its title on the top line with the arrow, amber while a key is down. */
function Shell({ down = false, title, status, children }: { down?: boolean; title: ReactNode; status?: ReactNode; children?: ReactNode }) {
  return (
    <Link
      href="/admin/you/ai-keys"
      className={`group grid gap-3 rounded-[20px] border bg-card p-4 text-inherit no-underline transition-[border-color,transform] hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring ${
        down ? 'border-[rgb(245_196_81/0.55)]' : 'border-border hover:border-foreground/25'
      }`}
      data-testid="ai-keys-card"
    >
      <div className="flex min-h-7 items-center gap-2.5">
        <KeyRound size={20} aria-hidden="true" className="shrink-0" />
        <h2 className="orbit-display text-lg font-bold">
          {title}
        </h2>
        <span className="ml-auto flex items-center gap-2.5">
          {status}
          <ArrowUpRight
            size={18}
            aria-hidden="true"
            className="shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground"
          />
        </span>
      </div>
      {children}
    </Link>
  );
}

/**
 * AI keys on You (#605): how your keys are doing, right under your profile. The whole card is one tap that opens the AI
 * keys page, where keys are added, lent and fixed; nothing inside it is a button. While the keys load, or if they
 * can't be read, the card still leads there.
 */
export function AiKeysCard() {
  const { result: text } = useAiKeys();
  const { result: voice } = useVoiceKeys();
  // Until both lists are read (or if either can't be) the card only leads to the page
  if (text.status !== 'ready' || voice.status !== 'ready') return <Shell title="AI keys" />;
  const keys: Row[] = [...text.items.map(textRow), ...voice.items.map(voiceRow)].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (keys.length === 0) {
    return (
      <Shell title="AI keys">
        <p className="text-[15px] leading-snug text-muted-foreground">
          Bots you make run on Universe AI. Add your own key to pick the AI they think with, or keep them on your own computer.
        </p>
        <div className="flex flex-wrap items-center gap-1 text-foreground/80" data-testid="ai-keys-card-logos">
          {SHOWN_KINDS.map((kind) => (
            <ProviderLogo key={kind} info={kindInfo(kind)} size={20} slot={30} />
          ))}
          <span className="ml-1 text-xs text-muted-foreground">and more</span>
        </div>
      </Shell>
    );
  }

  const down = keys.filter((key) => key.down).length;
  const replies = keys.reduce((total, key) => total + key.replies, 0);
  const more = keys.length - MAX_SHOWN;
  // A down key is always among the ones listed, so the card never says "1 down" without showing which.
  const shown = [...keys.filter((key) => key.down), ...keys.filter((key) => !key.down)].slice(0, MAX_SHOWN);
  const footer = [more > 0 && `${more} more`, replies > 0 && `${replies.toLocaleString()} ${replies === 1 ? 'reply' : 'replies'} on your keys this month`].filter(Boolean);
  return (
    <Shell
      down={down > 0}
      title={
        <>
          AI keys <span className="ml-0.5 text-[13px] font-semibold text-muted-foreground">{keys.length}</span>
        </>
      }
      status={
        <span className="flex items-center gap-1.5 text-[13px] font-semibold" data-testid="ai-keys-card-status">
          <Dot down={down > 0} />
          <span className={down > 0 ? 'text-[#92400E] dark:text-[#F5C451]' : undefined}>{down > 0 ? `${down} down` : keys.length === 1 ? 'Working' : 'All working'}</span>
        </span>
      }
    >
      <ul className="m-0 grid list-none p-0">
        {shown.map((key) => (
          <li key={key.id} className="grid gap-1 border-t border-border py-3 first:border-t-0 first:pt-1 last:pb-0" data-testid="ai-keys-card-key">
            <div className="flex min-w-0 items-center gap-2.5">
              <ProviderLogo info={key.logo} size={22} slot={28} />
              <strong className="min-w-0 flex-1 truncate text-[15px] font-semibold">{key.name}</strong>
              {key.down && (
                <span className="inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border border-[rgb(245_196_81/0.55)] px-2.5 text-[11px] font-semibold text-[#92400E] dark:text-[#F5C451]">
                  <Dot down />
                  Down
                </span>
              )}
            </div>
            <p className="pl-[38px] text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{keyLine(key)}</p>
          </li>
        ))}
      </ul>
      {footer.length > 0 && <p className="border-t border-border pt-3 text-[13px] text-muted-foreground">{footer.join(' · ')}</p>}
    </Shell>
  );
}
