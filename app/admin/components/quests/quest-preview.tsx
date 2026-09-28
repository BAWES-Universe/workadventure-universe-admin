'use client';

import { useState } from 'react';
import { Bot, SquareDashed, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  QUEST_COPY_LOCALES,
  QUEST_PATH_COPY,
  questCopy,
  questCopyDirection,
  type QuestCopyKey,
  type QuestCopyLocale,
} from '@/lib/quests/copy';
import { QUEST_MINUTES, QUEST_PATHS, type QuestHost, type QuestPath } from '@/lib/quests/model';
import { QuestStamp } from './quest-stamp';
import styles from './quests.module.css';

const LANGUAGE_NAME: Record<QuestCopyLocale, { short: string; name: string }> = {
  'en-US': { short: 'EN', name: 'English' },
  'fr-FR': { short: 'FR', name: 'Français' },
  'ar-SA': { short: 'AR', name: 'العربية' },
};

const SCREENS = ['The invitation', 'The options', 'The payoff'] as const;

export interface QuestPreviewProps {
  roomName: string;
  paths: Record<QuestPath, boolean>;
  /** The Explore area, when Explore is on and one is picked. */
  areaName: string | null;
  host: QuestHost;
}

/** Every string a visitor would read on each screen, in the order the screens come. */
function screenCopy({ roomName, paths, areaName, host }: QuestPreviewProps, locale: QuestCopyLocale) {
  const t = (key: QuestCopyKey, params?: Record<string, string | number>) => questCopy(key, params, locale);
  const area = areaName ?? '';
  const offered = QUEST_PATHS.filter((path) => paths[path] && (path !== 'explore' || areaName));
  const speaker = host.kind === 'none' ? roomName : host.name;
  const options = offered.map((path) => ({
    path,
    title: t(QUEST_PATH_COPY[path].title),
    description: t(QUEST_PATH_COPY[path].description, { area }),
    minutes: t('minutes', { minutes: QUEST_MINUTES[path] }),
  }));
  const first = offered[0];
  const payoff = first
    ? {
        path: first,
        line:
          first === 'meet'
            ? t(host.kind === 'bot' ? 'paths.meet.payoff' : 'paths.meet.payoffNeutral')
            : first === 'explore'
              ? t('paths.explore.payoff', { area })
              : t('paths.build.payoff'),
        badge: t('stamps.badge', { stamp: t(QUEST_PATH_COPY[first].stamp) }),
      }
    : null;
  return {
    speaker,
    invitation: { line: t('invitation.line'), secondary: t('invitation.secondary'), showOptions: t('invitation.showOptions'), notNow: t('invitation.notNow') },
    optionsTitle: t('options.title'),
    options,
    payoff,
  };
}

/**
 * The three screens a newcomer sees, with this room's names, in the game's own words (lib/quests). The pictures are
 * decorative; the same words are in a list for screen readers. Test run steps through them and saves nothing.
 */
export function QuestPreview(props: QuestPreviewProps) {
  const [locale, setLocale] = useState<QuestCopyLocale>('en-US');
  // null: all three screens at once; 0-2: a test run on that screen; 3: the test run finished.
  const [step, setStep] = useState<number | null>(null);
  const copy = screenCopy(props, locale);
  const { host } = props;
  const running = step !== null && step < SCREENS.length;
  const shows = (index: number) => step === null || step >= SCREENS.length || step === index;

  const eyebrow = (
    <div className={styles.eyebrow}>
      {host.kind !== 'none' && (
        <span className={styles.portrait}>{host.kind === 'bot' ? <Bot size={15} /> : <SquareDashed size={15} />}</span>
      )}
      <span>{copy.speaker}</span>
    </div>
  );

  // Past the last screen the run is finished; the next press starts again.
  const advance = () => setStep((current) => (current === null || current >= SCREENS.length ? 0 : current + 1));
  const runLabel =
    step === null || step >= SCREENS.length ? 'Test run' : step < SCREENS.length - 1 ? `Next: ${SCREENS[step + 1].toLowerCase()}` : 'Finish test run';

  return (
    <div className={styles.preview} data-testid="quest-preview">
      <div className={styles.previewHead}>
        <span className={styles.previewCaption}>As it appears on a phone in this room</span>
        <span className={styles.languages} role="group" aria-label="Preview language">
          {QUEST_COPY_LOCALES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={styles.language}
              aria-pressed={locale === candidate}
              aria-label={LANGUAGE_NAME[candidate].name}
              onClick={() => setLocale(candidate)}
            >
              {LANGUAGE_NAME[candidate].short}
            </button>
          ))}
        </span>
      </div>

      <div className={styles.strip} aria-hidden="true" dir={questCopyDirection(locale)} lang={locale}>
        {copy.options.length === 0 ? (
          <p className={styles.nothing}>Nothing to do here yet, so newcomers get no invitation.</p>
        ) : (
          <>
            {shows(0) && (
              <div className={cn(styles.screen, step === 0 && styles.current)} data-screen="invitation">
                <div className={styles.glass}>
                  {eyebrow}
                  <p className={styles.line}>{copy.invitation.line}</p>
                  <p className={styles.secondary}>{copy.invitation.secondary}</p>
                  <div className={styles.buttons}>
                    <span className={styles.cta}>{copy.invitation.showOptions}</span>
                    <span className={styles.ghost}>{copy.invitation.notNow}</span>
                  </div>
                </div>
              </div>
            )}
            {shows(1) && (
              <div className={cn(styles.screen, step === 1 && styles.current)} data-screen="options">
                <div className={styles.glass}>
                  <div className={styles.optionsHead}>
                    {host.kind !== 'none' && (
                      <span className={styles.portrait}>{host.kind === 'bot' ? <Bot size={15} /> : <SquareDashed size={15} />}</span>
                    )}
                    <p className={styles.line}>{copy.optionsTitle}</p>
                    <span className={styles.close}>
                      <X size={16} />
                    </span>
                  </div>
                  {copy.options.map((option) => (
                    <div key={option.path} className={styles.optionRow}>
                      <QuestStamp path={option.path} size="sm" />
                      <span className={styles.optionText}>
                        <strong>{option.title}</strong>
                        <span>{option.description}</span>
                      </span>
                      <span className={styles.minutes}>{option.minutes}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {shows(2) && copy.payoff && (
              <div className={cn(styles.screen, step === 2 && styles.current)} data-screen="payoff">
                <div className={cn(styles.glass, styles.payoff)}>
                  <QuestStamp path={copy.payoff.path} size="md" />
                  <span className={styles.payoffText}>
                    {eyebrow}
                    <span className={styles.line}>{copy.payoff.line}</span>
                    <span className={styles.secondary}>{copy.payoff.badge}</span>
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* What the pictures say, for screen readers; a test run marks the screen it is on. */}
      <ol className="sr-only" lang={locale} dir={questCopyDirection(locale)}>
        <li aria-current={step === 0 ? 'step' : undefined}>
          {SCREENS[0]}: {copy.speaker}. {copy.invitation.line} {copy.invitation.secondary} {copy.invitation.showOptions}. {copy.invitation.notNow}.
        </li>
        <li aria-current={step === 1 ? 'step' : undefined}>
          {SCREENS[1]}: {copy.optionsTitle} {copy.options.map((option) => `${option.title}: ${option.description} ${option.minutes}.`).join(' ')}
        </li>
        {copy.payoff && (
          <li aria-current={step === 2 ? 'step' : undefined}>
            {SCREENS[2]}: {copy.speaker}. {copy.payoff.line} {copy.payoff.badge}.
          </li>
        )}
      </ol>

      {copy.options.length > 0 && (
        <div className={styles.run}>
          <Button type="button" variant="outline" className="h-11" onClick={advance}>
            {runLabel}
          </Button>
          {running && (
            <span className={styles.runStep}>
              Step {step + 1} of {SCREENS.length}: {SCREENS[step].toLowerCase()}
            </span>
          )}
        </div>
      )}
      <p role="status" className={styles.rehearsal} data-testid="rehearsal-status">
        {step !== null ? 'Rehearsal only. Nothing was saved.' : ''}
      </p>
    </div>
  );
}
