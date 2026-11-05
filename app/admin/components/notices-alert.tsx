'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell, ChevronRight, KeyRound, LogIn, Loader2, Unplug, X } from 'lucide-react';
import { authenticatedFetch } from '@/lib/client-auth';
import { announceAttentionChanged } from './shell/attention-badge';
import { describeToolSignIn, type ToolSignInNoticeData } from '@/lib/tool-signin-words';

interface Notice {
  id: string;
  kind: string;
  title: string;
  body: string;
  badge: string | null;
  href: string | null;
  /** A lost tool sign-in carries its connections here (game #1819) */
  data?: ToolSignInNoticeData | null;
}

/** AI key notices (#374) wear the key; anything else a plain bell. */
function glyphOf(kind: string) {
  if (kind === 'tool-signin') return Unplug;
  return kind.startsWith('ai-key') ? KeyRound : Bell;
}

/** The time of day a connection stopped, in the viewer's clock. */
function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Orbit home: what Orbit has told you that you haven't dismissed (a key of yours is down, bots moved off a key in your
 * universe). One amber card each; the card leads to the page that explains it, and the X dismisses it on every device.
 * Nothing shows when there is nothing, and the card is extra: if it can't load, the home page carries on without it.
 */
export function NoticesAlert() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  // The connection whose sign-in window is open, and whether it could not be started
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [reconnectFailed, setReconnectFailed] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load(isCancelled: () => boolean = () => false, announce = false) {
    try {
      const response = await authenticatedFetch('/api/me/notices');
      if (!response.ok) return;
      const data = (await response.json()) as { notices?: Notice[] };
      if (!isCancelled()) {
        setNotices(data.notices ?? []);
        if (announce) announceAttentionChanged();
      }
    } catch {
      // Extra: without it Orbit home still works.
    }
  }

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  /** Reconnect Tavily (#1819): the same sign-in window the bot's tools page opens, without walking to the bot first. */
  async function reconnect(botId: string, server: { id: string; name: string }) {
    if (pollRef.current) clearInterval(pollRef.current);
    setReconnectFailed(null);
    setReconnecting(server.id);
    try {
      const redirectUrl = window.location.href.split('?')[0].split('#')[0];
      const response = await authenticatedFetch(
        `/api/bots/${encodeURIComponent(botId)}/mcp-servers/${encodeURIComponent(server.id)}/oauth/start?redirectUrl=${encodeURIComponent(redirectUrl)}`,
      );
      if (!response.ok) throw new Error('start failed');
      const { authorizeUrl } = (await response.json()) as { authorizeUrl?: string };
      const popup = authorizeUrl ? window.open(authorizeUrl, 'oauth-popup', 'width=600,height=700') : null;
      if (!popup) throw new Error('popup blocked');
      pollRef.current = setInterval(() => {
        if (!popup.closed) return;
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        setReconnecting(null);
        // The card goes by itself when the sign-in worked: the server takes it down
        void load(undefined, true);
      }, 500);
    } catch {
      setReconnecting(null);
      setReconnectFailed(server.id);
    }
  }

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
        // A lost tool sign-in is written here so its times are in the viewer's clock
        const signIn = notice.kind === 'tool-signin' && notice.data?.servers?.length ? notice.data : null;
        const words = signIn ? describeToolSignIn(signIn, clock) : notice;
        const text = (
          <>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <strong className="orbit-display text-[17px] font-bold leading-tight">{words.title}</strong>
              {words.badge && (
                <span className="inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border border-[rgb(245_196_81/0.55)] px-2.5 text-[11px] font-semibold text-[#F5C451]">
                  <i aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#F5C451]" />
                  {words.badge}
                </span>
              )}
            </span>
            <span className="mt-1 block text-[14px] leading-snug text-muted-foreground">{words.body}</span>
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
            <div className="min-w-0 flex-1 py-1">
              {notice.href ? (
                <Link href={notice.href} className="orbit-press block text-left">
                  {text}
                </Link>
              ) : (
                text
              )}
              {signIn && (
                <span className="mt-3 flex flex-wrap gap-2">
                  {signIn.servers
                    .filter((server) => server.kind === 'oauth')
                    .map((server) => (
                      <button
                        key={server.id}
                        type="button"
                        onClick={() => void reconnect(signIn.botId, server)}
                        disabled={reconnecting !== null}
                        className="orbit-press inline-flex h-11 items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-4 text-[14px] font-semibold text-foreground disabled:opacity-60"
                      >
                        {reconnecting === server.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <LogIn className="h-4 w-4" aria-hidden="true" />}
                        {reconnecting === server.id ? `Waiting for ${server.name}…` : `Reconnect ${server.name}`}
                      </button>
                    ))}
                  {signIn.servers.some((server) => server.id === reconnectFailed) && (
                    <span role="alert" className="block w-full text-xs text-[#fca5a5]">
                      That didn’t work. Try again.
                    </span>
                  )}
                </span>
              )}
            </div>
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
