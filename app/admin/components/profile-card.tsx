'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ExternalLink, Lock, Pencil, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { authenticatedFetch } from '@/lib/client-auth';
import { DraftNotice } from './draft-notice';
import { useDraft } from '../hooks/use-draft';
import styles from './profile-card.module.css';

export interface ProfileLink {
  label: string;
  url: string;
}
interface Profile {
  bio: string;
  links: ProfileLink[];
}

const EMPTY: Profile = { bio: '', links: [] };

/** A link other people can open: http(s) only, and with a label. */
export function profileLinkError(link: ProfileLink): string | null {
  if (!link.label.trim()) return 'Give every link a label.';
  try {
    const url = new URL(link.url.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
  } catch {
    return `“${link.url || link.label}” isn’t a web address. Start it with https://`;
  }
  return null;
}

/**
 * Your profile as other people see it when they click you in the game or find you in Users, edited in place.
 * Your email and role show only to you. An empty profile says what it's for and invites you to set it up.
 */
export function ProfileCard({
  user,
  startEditing = false,
}: {
  user: { name: string | null; email: string | null; isSuperAdmin?: boolean };
  startEditing?: boolean;
}) {
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [saved, setSaved] = useState<Profile>(EMPTY);
  const [form, setForm] = useState<Profile>(EMPTY);
  const [editing, setEditing] = useState(startEditing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const headingId = useId();
  const name = user.name || user.email || 'You';

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    authenticatedFetch('/api/admin/profile')
      .then(async (response) => {
        if (!response.ok) throw new Error('Profile unavailable');
        const data = await response.json();
        const profile: Profile = {
          bio: typeof data.bio === 'string' ? data.bio : '',
          links: Array.isArray(data.links) ? data.links : [],
        };
        if (cancelled) return;
        setSaved(profile);
        setForm(profile);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const draftValue = useMemo(() => form, [form]);
  const { discard, restored, revert } = useDraft('visit-card', draftValue, setForm, saved, status === 'ready');
  // Something you typed earlier and didn't save: pick up where you left off.
  useEffect(() => {
    if (restored) setEditing(true);
  }, [restored]);

  const cancel = useCallback(() => {
    revert();
    setForm(saved);
    setError(null);
    setEditing(false);
  }, [revert, saved]);

  async function save() {
    const links = form.links
      .map((link) => ({ label: link.label.trim(), url: link.url.trim() }))
      .filter((link) => link.label || link.url);
    const problem = links.map(profileLinkError).find(Boolean);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/admin/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bio: form.bio.trim() || null, links }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(typeof data.error === 'string' ? data.error : 'Couldn’t save your profile. Try again.');
      }
      const next = { bio: form.bio.trim(), links };
      setSaved(next);
      setForm(next);
      discard();
      setEditing(false);
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 3000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t save your profile. Try again.');
    } finally {
      setSaving(false);
    }
  }

  const updateLink = (index: number, field: keyof ProfileLink, value: string) =>
    setForm((current) => ({ ...current, links: current.links.map((link, i) => (i === index ? { ...link, [field]: value } : link)) }));

  const empty = !saved.bio && saved.links.length === 0;

  return (
    <section className={styles.card} aria-labelledby={headingId} data-testid="profile-card">
      <div className={styles.top}>
        <div className={styles.who}>
          <h1 id={headingId} className="orbit-display">
            {name}
          </h1>
          <p className={styles.private}>
            <Lock size={12} aria-hidden="true" />
            {user.name && user.email && <span>{user.email}</span>}
            {user.isSuperAdmin && (
              <span className={styles.badge}>
                <ShieldCheck size={12} aria-hidden="true" />
                Super admin
              </span>
            )}
            <span className={styles.onlyYou}>only you see this</span>
          </p>
        </div>
        {status === 'ready' && !editing && !empty && (
          <Button variant="outline" onClick={() => setEditing(true)} className="h-10 shrink-0 gap-2">
            <Pencil size={15} aria-hidden="true" />
            Edit profile
          </Button>
        )}
      </div>

      {status === 'loading' && (
        <p className={styles.status} role="status">
          Loading your profile…
        </p>
      )}
      {status === 'error' && (
        <div className={styles.status} role="alert">
          <p>We couldn’t load your profile.</p>
          <Button variant="outline" onClick={() => setAttempt((value) => value + 1)} className="h-10 gap-2">
            <RefreshCw size={14} aria-hidden="true" />
            Try again
          </Button>
        </div>
      )}

      {status === 'ready' && !editing && (
        <>
          {empty ? (
            <div className={styles.emptyState} data-testid="profile-empty">
              <p>
                <strong>People don’t know much about you yet.</strong> Add a few words and your links, so people know who
                you are when they meet you.
              </p>
              <Button onClick={() => setEditing(true)} className="h-11 gap-2 self-start px-5">
                <Plus size={16} aria-hidden="true" />
                Set up your profile
              </Button>
            </div>
          ) : (
            <div className={styles.public}>
              {saved.bio && <p className={styles.bio}>{saved.bio}</p>}
              {saved.links.length > 0 && (
                <ul className={styles.links}>
                  {saved.links.filter((link) => /^https?:\/\//i.test(link.url)).map((link, index) => (
                    <li key={`${link.url}-${index}`}>
                      <a href={link.url} target="_blank" rel="noopener noreferrer">
                        {link.label}
                        <ExternalLink size={13} aria-hidden="true" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className={styles.explain}>
            {justSaved ? (
              <span role="status">Saved. This is what people see now.</span>
            ) : (
              'This is what people see when they click you in the game or find you in Users.'
            )}
          </p>
        </>
      )}

      {status === 'ready' && editing && (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {restored && <DraftNotice onDiscard={cancel} />}
          <label className={styles.field}>
            <span>About you</span>
            <Textarea
              rows={4}
              value={form.bio}
              onChange={(event) => setForm((current) => ({ ...current, bio: event.target.value }))}
              placeholder="What you do, what you’re into, what people can talk to you about."
            />
          </label>
          <fieldset className={styles.field}>
            <legend>Links</legend>
            {form.links.length === 0 && <p className={styles.hint}>Your site, LinkedIn, GitHub, anything people can follow.</p>}
            {form.links.map((link, index) => (
              <div key={index} className={styles.linkRow}>
                <Input aria-label={`Link ${index + 1} label`} placeholder="Label, e.g. LinkedIn" value={link.label} onChange={(event) => updateLink(index, 'label', event.target.value)} />
                <Input aria-label={`Link ${index + 1} address`} type="url" inputMode="url" placeholder="https://" value={link.url} onChange={(event) => updateLink(index, 'url', event.target.value)} />
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={`Remove link ${index + 1}`}
                  onClick={() => setForm((current) => ({ ...current, links: current.links.filter((_, i) => i !== index) }))}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              className="h-10 gap-2 self-start"
              onClick={() => setForm((current) => ({ ...current, links: [...current.links, { label: '', url: '' }] }))}
            >
              <Plus size={15} aria-hidden="true" />
              Add a link
            </Button>
          </fieldset>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <p className={styles.explain}>People see this when they click you in the game or find you in Users.</p>
          <div className={styles.actions}>
            <Button type="submit" disabled={saving} className="h-11 px-6">
              {saving ? 'Saving…' : 'Save profile'}
            </Button>
            <Button type="button" variant="outline" onClick={cancel} disabled={saving} className="h-11 px-5">
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
