'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bell, ChevronRight, KeyRound, X } from 'lucide-react';
import { authenticatedFetch } from '@/lib/client-auth';
import { announceAttentionChanged } from './shell/attention-badge';

interface Notice {
  id: string;
  kind: string;
  title: string;
  body: string;
  badge: string | null;
  href: string | null;
}

/** AI key notices (#374) wear the key; anything else a plain bell. */
function glyphOf(kind: string) {
  return kind.startsWith('ai-key') ? KeyRound : Bell;
}

/**
 * Orbit home: what Orbit has told you that you haven't dismissed (a key of yours is down, bots moved off a key in your
 * universe). One amber card each; the card leads to the page that explains it, and the X dismisses it on every device.
 * Nothing shows when there is nothing, and the card is extra: if it can't load, the home page carries on without it.
 */
export function NoticesAlert() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    authenticatedFetch('/api/me/notices')
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()) as { notices?: Notice[] };
        if (!cancelled) setNotices(data.notices ?? []);
      })
      .catch(() => {
        // Extra: without it Orbit home still works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function dismiss(notice: Notice) {
    setFailed(null);
    try {
      const response = await authenticatedFetch(`/api/me/notices/${encodeURIComponent(notice.id)}`, { method: 'DELETE' });
      // Already gone (dismissed on another device): the card is right to go.
      if (!response.ok && response.status !== 404) throw new Error('failed');
      setNotices((current) => current.filter((entry) => entry.id !== notice.id));
      announceAttentionChanged();
    } catch {
      setFailed(notice.id);
    }
  }

  if (notices.length === 0) return null;

  return (
    <div className="grid gap-3" data-testid="notices">
      {notices.map((notice) => {
        const Glyph = glyphOf(notice.kind);
        const text = (
          <>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <strong className="orbit-display text-[17px] font-bold leading-tight">{notice.title}</strong>
              {notice.badge && (
                <span className="inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border border-[rgb(245_196_81/0.55)] px-2.5 text-[11px] font-semibold text-[#F5C451]">
                  <i aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#F5C451]" />
                  {notice.badge}
                </span>
              )}
            </span>
            <span className="mt-1 block text-[14px] leading-snug text-muted-foreground">{notice.body}</span>
            {failed === notice.id && (
              <span role="alert" className="mt-1 block text-xs text-[#fca5a5]">
                That didn’t work. Try again.
              </span>
            )}
          </>
        );
        return (
          <div
            key={notice.id}
            className="orbit-rise relative flex min-w-0 gap-3 rounded-[18px] border border-[rgb(245_196_81/0.45)] bg-card bg-[linear-gradient(160deg,rgb(245_196_81/0.10),transparent_55%)] py-3 pl-4 pr-1"
            data-testid="notice"
          >
            <Glyph size={26} className="mt-1 shrink-0 text-[#F5C451]" aria-hidden="true" />
            {notice.href ? (
              <Link href={notice.href} className="orbit-press min-w-0 flex-1 py-1 text-left">
                {text}
              </Link>
            ) : (
              <div className="min-w-0 flex-1 py-1">{text}</div>
            )}
            <div className="flex shrink-0 flex-col items-center justify-between">
              <button
                type="button"
                onClick={() => void dismiss(notice)}
                aria-label={`Dismiss: ${notice.title}`}
                className="orbit-press flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
              {notice.href && <ChevronRight size={20} className="mb-3 text-muted-foreground" aria-hidden="true" />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
