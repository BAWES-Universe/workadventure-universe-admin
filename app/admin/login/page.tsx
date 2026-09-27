'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import { OrbitLoader } from '../components/shell/orbit-loader';
import { OrbitMark } from '../components/shell/orbit-mark';
import { adoptHandshakeSession, isOpaqueSessionId, purgeAccountState } from '@/lib/client-auth';
import { PLAY_ORIGIN, PLAY_URL, isInsideFrame } from '@/lib/play-origin';

const ENABLE_MANUAL_LOGIN = process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_ENABLE_MANUAL_LOGIN === 'true';
const LOGOUT_SUPPRESSION_KEY = 'orbit_auth_suppressed';
/** How long to wait for the game to answer the handshake before showing the "runs inside Universe" line. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

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

type AuthMessage = { type: 'orbit-auth-token-v2'; version: 2; nonce: string; accessToken: string };

function getSafeRedirect(): string {
  const requested = new URL(window.location.href).searchParams.get('redirect');
  if (!requested) return '/admin';
  const target = new URL(requested, window.location.origin);
  if (target.origin !== window.location.origin ||
      (target.pathname !== '/admin' && !target.pathname.startsWith('/admin/'))) return '/admin';
  return `${target.pathname}${target.search}${target.hash}`;
}

export default function LoginPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manualToken, setManualToken] = useState('');
  const [signedOut, setSignedOut] = useState(false);
  const [outsideUniverse, setOutsideUniverse] = useState(false);
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
    // The stored session is never reused: the game's handshake decides who is
    // signed in, and caches from a different (or unknown) account are dropped.
    adoptHandshakeSession({ sessionId: data.sessionId, expiresAt: data.expiresAt, userUuid: await fetchSessionUserUuid(data.sessionId) });
    sessionStorage.removeItem(LOGOUT_SUPPRESSION_KEY);
    window.location.replace(getSafeRedirect());
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
    if (handshakeTimer.current) clearTimeout(handshakeTimer.current);
    handshakeTimer.current = setTimeout(() => {
      if (activeNonce.current !== nonce) return;
      // No answer from the game: nothing here can say who is signed in, so keep nothing.
      activeNonce.current = null;
      purgeAccountState();
      setOutsideUniverse(true);
      setLoading(false);
    }, HANDSHAKE_TIMEOUT_MS);
    window.parent.postMessage({ type: 'orbit-auth-ready-v2', version: 2, nonce, ...(refresh ? { refresh: true } : {}) }, PLAY_ORIGIN);
    setLoading(true);
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== PLAY_ORIGIN || event.source !== window.parent) return;
      const message = event.data as Partial<AuthMessage>;
      if (message.type !== 'orbit-auth-token-v2' || message.version !== 2 ||
          message.nonce !== activeNonce.current || typeof message.accessToken !== 'string') return;
      activeNonce.current = null;
      if (handshakeTimer.current) clearTimeout(handshakeTimer.current);
      void exchangeToken(message.accessToken).catch((cause) => {
        const reason = cause instanceof Error ? cause.message : 'Login failed';
        // Refused with an expired token: ask the game for a renewed one, once.
        if (/expired/i.test(reason) && !renewalTried.current) {
          renewalTried.current = true;
          beginIframeHandshake(true);
          return;
        }
        setError(
          renewalTried.current && /expired/i.test(reason)
            ? 'Universe couldn\'t sign you in to Orbit. Select Continue with Universe to try again.'
            : reason,
        );
        setLoading(false);
      });
    };
    window.addEventListener('message', onMessage);

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
      if (handshakeTimer.current) clearTimeout(handshakeTimer.current);
    };
  }, [beginIframeHandshake, exchangeToken]);

  const submitManual = (event: FormEvent) => {
    event.preventDefault();
    void exchangeToken(manualToken).catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'Login failed');
      setLoading(false);
    });
  };

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <OrbitLoader />
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
          {isInsideFrame() && <Button className="w-full" onClick={() => { renewalTried.current = false; beginIframeHandshake(); }}>Try again</Button>}
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
          renewalTried.current = false;
          beginIframeHandshake();
        }}>
          Continue with Universe
        </Button>
        {manualForm}
      </div>
    </div>
  );
}
