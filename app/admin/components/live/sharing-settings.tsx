'use client';

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { authenticatedFetch } from '@/lib/client-auth';
import {
  SHARE_PASSPORT_KEY,
  SHARE_ROOM_KEY,
  SHARING_KEYS,
  shareRoomFromRows,
  sharePassportFromRows,
  type Audience,
} from '@/lib/people-settings';
import styles from '../../sharing/sharing.module.css';

const LABEL: Record<Audience, string> = { everyone: 'Everyone', friends: 'Friends', nobody: 'No one' };
const CHOICES: Audience[] = ['everyone', 'friends', 'nobody'];

type Choices = { room: Audience; passport: Audience };

/** The caller's two sharing choices, saved the moment one changes; a failed save puts the old choice back. */
function useSharing() {
  const [choices, setChoices] = useState<Choices | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authenticatedFetch('/api/me/preferences')
      .then(async (response) => {
        if (!response.ok) throw new Error(`Preferences answered ${response.status}`);
        const data = (await response.json()) as { preferences?: Record<string, unknown> };
        const rows = SHARING_KEYS.map((key) => ({ key, value: data.preferences?.[key] }));
        if (!cancelled) setChoices({ room: shareRoomFromRows(rows), passport: sharePassportFromRows(rows) });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const change = async (field: keyof Choices, value: Audience) => {
    const before = choices;
    if (!before) return;
    setChoices({ ...before, [field]: value });
    setFailed(false);
    try {
      const response = await authenticatedFetch('/api/me/preferences', {
        method: 'PUT',
        body: JSON.stringify({ key: field === 'room' ? SHARE_ROOM_KEY : SHARE_PASSPORT_KEY, value }),
      });
      if (!response.ok) throw new Error(`Preferences answered ${response.status}`);
    } catch {
      setChoices(before);
      setFailed(true);
    }
  };
  return { choices, failed, change };
}

/**
 * The dropdown that opens the three answers, behaving like the game's device list: it closes on a tap or click anywhere
 * else (which also closes it when the other one is opened), on Escape and on Tab; arrow keys move, Enter picks, and the
 * list opens upward when there is no room under the field.
 */
function AudiencePick({ id, label, value, disabled, onPick }: { id: string; label: string; value: Audience | null; disabled: boolean; onPick: (value: Audience) => void }) {
  const [open, setOpen] = useState(false);
  const [upward, setUpward] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLUListElement>(null);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) head.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        head.current?.focus();
      }
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const options = () => (panel.current ? Array.from(panel.current.querySelectorAll<HTMLButtonElement>('[role=option]')) : []);
  const focusOption = (index: number) => {
    const buttons = options();
    buttons[Math.min(Math.max(index, 0), buttons.length - 1)]?.focus();
  };

  const show = () => {
    if (disabled || !head.current) return;
    const rect = head.current.getBoundingClientRect();
    const listHeight = CHOICES.length * 46 + 12;
    setUpward(rect.bottom + listHeight + 8 > window.innerHeight && rect.top - listHeight - 8 > 0);
    setOpen(true);
  };

  // Opening puts the focus on the chosen row
  useEffect(() => {
    if (open) focusOption(Math.max(0, CHOICES.indexOf(value as Audience)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onHeadKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      if (open) close();
      else show();
    }
  };

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const buttons = options();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let handled = true;
    if (event.key === 'ArrowDown') focusOption(index + 1);
    else if (event.key === 'ArrowUp') focusOption(index - 1);
    else if (event.key === 'Home') focusOption(0);
    else if (event.key === 'End') focusOption(buttons.length - 1);
    else if (event.key === 'Escape') close();
    else if (event.key === 'Tab') {
      close(false);
      handled = false;
    } else handled = false;
    if (handled) event.preventDefault();
  };

  return (
    <div className={styles.pickWrap} ref={root}>
      <button
        type="button"
        ref={head}
        className={styles.pick}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label ${id}-value`}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onHeadKeyDown}
        data-testid={id}
      >
        <span id={`${id}-value`} className={styles.value}>
          {value ? LABEL[value] : '…'}
        </span>
        <ChevronDown size={16} className={styles.chevron} data-open={open} aria-hidden="true" />
      </button>
      {open && (
        <ul className={styles.menu} data-upward={upward} role="listbox" aria-label={label} ref={panel} onKeyDown={onPanelKeyDown}>
          {CHOICES.map((choice) => (
            <li key={choice} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={choice === value}
                className={styles.option}
                onClick={() => {
                  close();
                  if (choice !== value) onPick(choice);
                }}
              >
                <span className={styles.optionLabel}>{LABEL[choice]}</span>
                {choice === value && <Check size={18} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Who sees which room you are in, and who sees your passport. Everyone until you choose otherwise. */
export function SharingSettings() {
  const { choices, failed, change } = useSharing();
  const loading = choices === null && !failed;
  return (
    <section className={styles.card} aria-label="Sharing" id="sharing">
      <div className={styles.line}>
        <div>
          <h2 id="share-room-label" className={styles.q}>
            Share which room I’m in with
          </h2>
          <p className={styles.hint} id="share-room-hint">
            Shows in Live now and your friends’ list.
          </p>
        </div>
        <AudiencePick id="share-room" label="Share which room I’m in with" value={choices?.room ?? null} disabled={loading || failed} onPick={(value) => change('room', value)} />
      </div>
      <div className={styles.line}>
        <div>
          <h2 id="share-passport-label" className={styles.q}>
            Show my passport to
          </h2>
          <p className={styles.hint} id="share-passport-hint">
            The stamps on your profile.
          </p>
        </div>
        <AudiencePick id="share-passport" label="Show my passport to" value={choices?.passport ?? null} disabled={loading || failed} onPick={(value) => change('passport', value)} />
      </div>
      {failed && (
        <p className={styles.hint} role="status">
          Couldn’t save that. Try again.
        </p>
      )}
    </section>
  );
}
