'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import { OrbitLoader } from '../components/shell/orbit-loader';
import { OrbitMark } from '../components/shell/orbit-mark';
import { adoptHandshakeSession, getRememberedPlayUri, isOpaqueSessionId, purgeAccountState, rememberPlayUri } from '@/lib/client-auth';
import { PLAY_ORIGIN, PLAY_URL, isInsideFrame } from '@/lib/play-origin';
import { loginDestination, readResumePath } from '@/lib/resume-path';

const ENABLE_MANUAL_LOGIN = process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_ENABLE_MANUAL_LOGIN === 'true';
const LOGOUT_SUPPRESSION_KEY = 'orbit_auth_suppressed';
/** How long to wait for the game to answer the handshake before showing the "runs inside Universe" line. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/**
 * Once the game says it is still getting a token (renewing it, or waiting for the connection), how long to wait for
 * its next word. It says so at least every 25 seconds while it tries, and says when it gives up.
 */
const STILL_TRYING_TIMEOUT_MS = 45_000;
/** After this long, the loader says the sign-in is still going and why. */
const SLOW_AFTER_MS = 4_000;
/** Orbit's own sign-in call can fail for a dropped connection too: it asks the game again, this many times. */
const EXCHANGE_NETWORK_RETRIES = 5;
const EXCHANGE_RETRY_DELAY_MS = 2_000;

/** Who the freshly exchanged session belongs to; null when it cannot be confirmed. */
async function fetchSessionUserUuid(sessionId: string): Promise<string | null> {
  try {
    const response = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${sessionId}` }, credentials: 'omit' });
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data?.user?.uuid === 'string' && data.user.uuid ? data.user.uuid : null;
  } catch {
    return null;
  }
}

/** Whether the browser says it has no connection. */
function browserIsOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** fetch() rejects with a TypeError when the request never got an answer (no connection). */
function isNetworkFailure(cause: unknown): boolean {
  return cause instanceof TypeError;
}

function getSafeRedirect(): string {
  return loginDestination(window.location.href, readResumePath());
}

export default function LoginPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manualToken, setManualToken] = useState('');
  const [signedOut, setSignedOut] = useState(false);
  const [outsideUniverse, setOutsideUniverse] = useState(false);
  // The game could not get a token, or Orbit refused the renewed one: only Try again is left.
  const [cannotSignIn, setCannotSignIn] = useState(false);
  const [slow, setSlow] = useState(false);
  const [offline, setOffline] = useState(false);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exchangeRetries = useRef(0);
  const activeNonce = useRef<string | null>(null);
  const handshakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One second try with a renewed token: the game's OIDC access token runs out long before its own sign-in does.
  const renewalTried = useRef(false);

  const exchangeToken = useCallback(async (accessToken: string) => {
    setLoading(true);
    setError(null);
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({ accessToken }),
    });
    const data = await response.json();
    if (!response.ok || data.version !== 2 || !isOpaqueSessionId(data.sessionId) || !Number.isFinite(data.expiresAt)) {
      throw new Error(data.error || 'Invalid login response');
    }
    // Signing in again (a session that ran out, a sign-out) comes back here without the room; it is still this frame's.
    const keptPlayUri = getRememberedPlayUri();
    // The stored session is never reused: the game's handshake decides who is
    // signed in, and caches from a different (or unknown) account are dropped.
    adoptHandshakeSession({ sessionId: data.sessionId, expiresAt: data.expiresAt, userUuid: await fetchSessionUserUuid(data.sessionId) });
    sessionStorage.removeItem(LOGOUT_SUPPRESSION_KEY);
    // The game opens Orbit with the room the player is in; it decides which outfit people are drawn in.
    rememberPlayUri(new URL(window.location.href).searchParams.get('playUri') ?? keptPlayUri, isInsideFrame());
    window.location.replace(getSafeRedirect());
  }, []);

  /** Gives up on the game after `ms` with no word from it about this request. */
  const waitForGame = useCallback((nonce: string, ms: number) => {
    if (handshakeTimer.current) clearTimeout(handshakeTimer.current);
    handshakeTimer.current = setTimeout(() => {
      if (activeNonce.current !== nonce) return;
      // No answer from the game: nothing here can say who is signed in, so keep nothing.
      activeNonce.current = null;
      purgeAccountState();
      setOutsideUniverse(true);
      setLoading(false);
    }, ms);
  }, []);

  const beginIframeHandshake = useCallback((refresh = false) => {
    if (!isInsideFrame()) {
      setOutsideUniverse(true);
      setLoading(false);
      return;
    }
    const nonce = crypto.randomUUID();
    activeNonce.current = nonce;
    setOutsideUniverse(false);
    setCannotSignIn(false);
    setSlow(false);
    if (slowTimer.current) clearTimeout(slowTimer.current);
    slowTimer.current = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    waitForGame(nonce, HANDSHAKE_TIMEOUT_MS);
    window.parent.postMessage({ type: 'orbit-auth-ready-v2', version: 2, nonce, ...(refresh ? { refresh: true } : {}) }, PLAY_ORIGIN);
    setLoading(true);
  }, [waitForGame]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== PLAY_ORIGIN || event.source !== window.parent) return;
      // The game's answers: a token, a word that it is still getting one, or that it can't.
      const message = event.data as Partial<{ type: string; version: number; nonce: string; accessToken: unknown }>;
      if (message.version !== 2 || !message.nonce || message.nonce !== activeNonce.current) return;
      const nonce = message.nonce;
      if (message.type === 'orbit-auth-wait-v2') {
        // The game is there and still getting a token: keep waiting for it.
        waitForGame(nonce, STILL_TRYING_TIMEOUT_MS);
        return;
      }
      if (message.type === 'orbit-auth-failed-v2') {
        activeNonce.current = null;
        if (handshakeTimer.current) clearTimeout(handshakeTimer.current);
        setCannotSignIn(true);
        setLoading(false);
        return;
      }
      if (message.type !== 'orbit-auth-token-v2' || typeof message.accessToken !== 'string') return;
      activeNonce.current = null;
      if (handshakeTimer.current) clearTimeout(handshakeTimer.current);
      void exchangeToken(message.accessToken).catch((cause) => {
        // The connection dropped on the way to Orbit: ask the game again once it is back.
        if (isNetworkFailure(cause) && exchangeRetries.current < EXCHANGE_NETWORK_RETRIES) {
          exchangeRetries.current += 1;
          const again = () => {
            window.removeEventListener('online', again);
            clearTimeout(timer);
            beginIframeHandshake();
          };
          const timer = setTimeout(again, browserIsOffline() ? STILL_TRYING_TIMEOUT_MS : EXCHANGE_RETRY_DELAY_MS);
          if (browserIsOffline()) window.addEventListener('online', again);
          return;
        }
        const reason = cause instanceof Error ? cause.message : 'Login failed';
        // Refused with an expired token: ask the game for a renewed one, once.
        if (/expired/i.test(reason) && !renewalTried.current) {
          renewalTried.current = true;
          beginIframeHandshake(true);
          return;
        }
        if (renewalTried.current && /expired/i.test(reason)) setCannotSignIn(true);
        else setError(reason);
        setLoading(false);
      });
    };
    window.addEventListener('message', onMessage);
    const onConnectionChange = () => setOffline(browserIsOffline());
    onConnectionChange();
    window.addEventListener('online', onConnectionChange);
    window.addEventListener('offline', onConnectionChange);

    // A stored session is never trusted on its own: the game may be signed in as
    // someone else in this tab. Opened outside the game, nothing is fetched or reused.
    if (isInsideFrame() && sessionStorage.getItem(LOGOUT_SUPPRESSION_KEY) === 'true') {
      queueMicrotask(() => {
        setSignedOut(true);
        setLoading(false);
      });
    } else {
      queueMicrotask(beginIframeHandshake);
    }
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('online', onConnectionChange);
      window.removeEventListener('offline', onConnectionChange);
      if (handshakeTimer.current) clearTimeout(handshakeTimer.current);
      if (slowTimer.current) clearTimeout(slowTimer.current);
    };
  }, [beginIframeHandshake, exchangeToken, waitForGame]);

  const submitManual = (event: FormEvent) => {
    event.preventDefault();
    void exchangeToken(manualToken).catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'Login failed');
      setLoading(false);
    });
  };

  if (loading) {
    // Most sign-ins finish in under a second; past a few seconds, say what Orbit is waiting for.
    const waiting = offline
      ? { label: 'Waiting for your connection…', detail: 'Orbit opens by itself when you’re back online.' }
      : slow
        ? { label: 'Still signing you in…', detail: 'Your connection is slow.' }
        : null;
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        {waiting ? <OrbitLoader label={waiting.label} detail={waiting.detail} dimmed={offline} /> : <OrbitLoader />}
      </div>
    );
  }

  const tryAgain = () => {
    renewalTried.current = false;
    exchangeRetries.current = 0;
    beginIframeHandshake();
  };

  if (cannotSignIn) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-4">
        <div className="orbit-card orbit-rise w-full max-w-md space-y-5 p-6 text-center">
          <OrbitMark className="mx-auto h-12 w-12" />
          <div className="space-y-2">
            <h1 className="text-xl font-semibold tracking-tight">Couldn’t sign you in</h1>
            <p className="text-sm text-muted-foreground">Universe couldn’t confirm it’s you just now.</p>
          </div>
          <Button className="w-full" onClick={tryAgain}>Try again</Button>
        </div>
      </div>
    );
  }

  const manualForm = ENABLE_MANUAL_LOGIN && (
    <form className="space-y-3 border-t border-border/60 pt-4" onSubmit={submitManual}>
      <Label htmlFor="accessToken">Development OIDC token</Label>
      <Input id="accessToken" value={manualToken} onChange={(event) => setManualToken(event.target.value)} required />
      <Button type="submit" variant="secondary" className="w-full">Development sign in</Button>
    </form>
  );

  if (outsideUniverse) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-4">
        <div className="orbit-card orbit-rise w-full max-w-md space-y-5 p-6 text-center">
          <OrbitMark className="mx-auto h-12 w-12" />
          <p className="text-[15px]">Orbit runs inside Universe. <a className="font-medium text-primary underline-offset-4 hover:underline" href={PLAY_URL} target="_top" rel="noopener">Open Universe</a></p>
          {isInsideFrame() && <Button className="w-full" onClick={tryAgain}>Try again</Button>}
          {manualForm}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <div className="orbit-card orbit-rise w-full max-w-md space-y-5 p-6">
        <div className="space-y-2 text-center">
          <OrbitMark className="mx-auto h-12 w-12" />
          <h1 className="text-xl font-semibold tracking-tight">{signedOut ? 'Signed out' : 'Sign in to Orbit'}</h1>
          <p className="text-sm text-muted-foreground">{signedOut ? 'Your Orbit session has been revoked.' : 'Waiting for Universe authentication.'}</p>
        </div>
        {error && <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertTitle>Authentication failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
        <Button className="w-full" onClick={() => {
          setSignedOut(false);
          sessionStorage.removeItem(LOGOUT_SUPPRESSION_KEY);
          // A fresh attempt gets its own renewal try, so an expired token can still be renewed from here.
          tryAgain();
        }}>
          Continue with Universe
        </Button>
        {manualForm}
      </div>
    </div>
  );
}
