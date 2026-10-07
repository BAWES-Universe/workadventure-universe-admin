'use client';

import { useEffect, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { authenticatedFetch } from '@/lib/client-auth';
import { cn } from '@/lib/utils';
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

/** A pill that opens the three answers. */
function AudiencePick({ id, label, value, disabled, onPick }: { id: string; label: string; value: Audience | null; disabled: boolean; onPick: (value: Audience) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.pickWrap}>
      <button
        type="button"
        className={cn('orbit-press', styles.pick)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label ${id}-value`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        data-testid={id}
      >
        <span id={`${id}-value`}>{value ? LABEL[value] : '…'}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <ul className={styles.menu} role="listbox" aria-label={label}>
          {CHOICES.map((choice) => (
            <li key={choice} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={choice === value}
                className={styles.option}
                onClick={() => {
                  setOpen(false);
                  onPick(choice);
                }}
              >
                {LABEL[choice]}
                {choice === value && <Check size={16} aria-hidden="true" />}
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
