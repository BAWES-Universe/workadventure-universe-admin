'use client';

import { Bot, Plus, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { VoiceKeySummary } from '@/lib/voice-keys';
import { voiceKeyCompanyInfo } from '@/lib/voice-key-companies';
import { count } from '../../components/ds';
import { Planet } from '../../components/ds/planet-icon';
import { ProviderLogo } from '../../components/ds/provider-logo';
import { RenameButton, RenameKey } from './rename-key';
import { StatusPill } from './key-text';
import { VOICE_IF_DOWN, describeVoice, lentModelsLine, voiceBotLine, voiceDownText, type VoiceLent } from './voice-key-text';

/**
 * A voice key on the AI keys page (#749): the same card as a text key, for what a speech company's key is. What it paid for is
 * voice replies; it has no limits, and no other voice to move to when it is down (bots reply in text).
 */
export function VoiceKeyCard({
  keyItem: key,
  renaming,
  checking,
  busy,
  onRename,
  onCancelRename,
  onRenamed,
  onCheck,
  onLend,
  onEditModels,
  onPull,
}: {
  keyItem: VoiceKeySummary;
  renaming: boolean;
  checking: boolean;
  busy: boolean;
  onRename: () => void;
  onCancelRename: () => void;
  onRenamed: (name: string) => void;
  onCheck: () => void;
  onLend: () => void;
  onEditModels: (universeId: string) => void;
  onPull: (lent: VoiceLent) => void;
}) {
  const down = key.health.status === 'down';
  const logo = { logo: voiceKeyCompanyInfo(key.adapter)?.logo };
  return (
    <article
      className={`grid gap-4 rounded-2xl border bg-foreground/[.03] p-4 ${down ? 'border-[rgb(245_196_81/0.55)]' : 'border-foreground/10'}`}
      data-testid="ai-key"
      data-voice="true"
    >
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {renaming ? (
            <RenameKey keyItem={key} logo={logo} base="/api/me/voice-keys" where="under Voice" onCancel={onCancelRename} onRenamed={onRenamed} />
          ) : (
            <>
              <ProviderLogo info={logo} />
              <h2 className="orbit-display text-lg font-bold [overflow-wrap:anywhere]">{key.name}</h2>
              <RenameButton name={key.name} onClick={onRename} />
              <StatusPill down={down} />
            </>
          )}
        </div>
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{describeVoice(key)}</p>
      </header>
      {down && (
        <p className="text-[15px] leading-snug text-muted-foreground" data-testid="ai-key-down-text">
          {voiceDownText(key)}
        </p>
      )}
      <div className="grid gap-1">
        <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">This month</h3>
        <p className="text-[15px]">{count(key.month.voiceReplies, 'voice reply', 'voice replies')}</p>
      </div>
      <div className="grid gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Lent to</h3>
        {key.lentTo.length === 0 && <p className="text-[15px] text-muted-foreground">No universe yet. Only you can see this key.</p>}
        {key.lentTo.map((lent) => (
          <div key={lent.universeId} className="grid gap-2 rounded-2xl border border-foreground/10 bg-foreground/[.04] p-3" data-testid="ai-key-lent">
            <div className="flex items-center gap-2">
              <strong className="flex min-w-0 flex-1 items-center gap-2 text-[15px]">
                <Planet size={16} aria-hidden="true" className="shrink-0 text-[rgba(167,139,250,.9)]" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{lent.universeName}</span>
              </strong>
              <button
                type="button"
                aria-label={`Pull ${key.name} from ${lent.universeName}`}
                disabled={busy}
                onClick={() => onPull(lent)}
                className="orbit-press -my-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-foreground/[0.08]"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <div className="flex items-center gap-2 rounded-xl bg-foreground/[.04] py-1 pl-3 pr-1">
              <span className="min-w-0 flex-1 text-[13px]" data-testid="lent-models">
                <span className="block text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Models</span>
                <span className="block [overflow-wrap:anywhere]">{lentModelsLine(key, lent)}</span>
              </span>
              <Button variant="outline" className="h-11 shrink-0 px-4" onClick={() => onEditModels(lent.universeId)} data-testid="lent-edit-models" aria-label={`Change the models bots in ${lent.universeName} may use`}>
                Change
              </Button>
            </div>
            {lent.bots.map((bot) => (
              <span key={bot.id} className="flex items-start gap-2 text-[13px] text-muted-foreground [overflow-wrap:anywhere]">
                <Bot size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span className="min-w-0">{voiceBotLine(bot)}</span>
              </span>
            ))}
          </div>
        ))}
      </div>
      <div className="grid gap-2" data-testid="ai-key-if-down">
        <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">If this is down</h3>
        <p className="text-sm text-muted-foreground" data-testid="ai-key-if-down-help">
          {VOICE_IF_DOWN}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {down && (
          <Button variant="outline" className="h-11 w-fit px-5" disabled={checking} onClick={onCheck}>
            <RefreshCw aria-hidden="true" className={checking ? 'animate-spin' : undefined} />
            {checking ? 'Checking…' : 'Check now'}
          </Button>
        )}
        <Button variant="outline" className="h-11 w-fit px-5" onClick={onLend}>
          <Plus aria-hidden="true" />
          Lend to a universe
        </Button>
      </div>
    </article>
  );
}
