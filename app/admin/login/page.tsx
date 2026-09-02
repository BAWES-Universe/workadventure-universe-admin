'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { getClientSessionId, isOpaqueSessionId, storeClientSession } from '@/lib/client-auth';

const ENABLE_MANUAL_LOGIN = process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_ENABLE_MANUAL_LOGIN === 'true';
const PLAY_ORIGIN = new URL(process.env.NEXT_PUBLIC_PLAY_URL || (process.env.NODE_ENV !== 'production' ? 'http://play.workadventure.localhost' : (() => { throw new Error('NEXT_PUBLIC_PLAY_URL is required in production'); })())).origin;
const LOGOUT_SUPPRESSION_KEY = 'orbit_auth_suppressed';

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
  const activeNonce = useRef<string | null>(null);

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
    storeClientSession(data.sessionId, data.expiresAt);
    sessionStorage.removeItem(LOGOUT_SUPPRESSION_KEY);
    window.location.replace(getSafeRedirect());
  }, []);

  const beginIframeHandshake = useCallback(() => {
    if (window.self === window.top) {
      setLoading(false);
      return;
    }
    const nonce = crypto.randomUUID();
    activeNonce.current = nonce;
    window.parent.postMessage({ type: 'orbit-auth-ready-v2', version: 2, nonce }, PLAY_ORIGIN);
    setLoading(true);
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== PLAY_ORIGIN || event.source !== window.parent) return;
      const message = event.data as Partial<AuthMessage>;
      if (message.type !== 'orbit-auth-token-v2' || message.version !== 2 ||
          message.nonce !== activeNonce.current || typeof message.accessToken !== 'string') return;
      activeNonce.current = null;
      void exchangeToken(message.accessToken).catch((cause) => {
        setError(cause instanceof Error ? cause.message : 'Login failed');
        setLoading(false);
      });
    };
    window.addEventListener('message', onMessage);

    // Existing v2 sessions survive iframe reloads without cookies.
    const sessionId = getClientSessionId();
    if (sessionId) {
      fetch('/api/auth/me', { headers: { Authorization: `Bearer ${sessionId}` }, credentials: 'omit' })
        .then((response) => response.ok ? window.location.replace(getSafeRedirect()) : beginIframeHandshake())
        .catch(beginIframeHandshake);
    } else if (sessionStorage.getItem(LOGOUT_SUPPRESSION_KEY) === 'true') {
      queueMicrotask(() => {
        setSignedOut(true);
        setLoading(false);
      });
    } else {
      queueMicrotask(beginIframeHandshake);
    }
    return () => window.removeEventListener('message', onMessage);
  }, [beginIframeHandshake, exchangeToken]);

  const submitManual = (event: FormEvent) => {
    event.preventDefault();
    void exchangeToken(manualToken).catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'Login failed');
      setLoading(false);
    });
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-background"><div className="text-center"><Spinner className="size-8 mx-auto mb-4" /><p>Loading your orbit..</p></div></div>;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{signedOut ? 'Signed out' : 'Sign in to Orbit'}</CardTitle>
          <CardDescription>{signedOut ? 'Your Orbit session has been revoked.' : 'Waiting for Universe authentication.'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertTitle>Authentication failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
          <Button className="w-full" onClick={() => { setSignedOut(false); sessionStorage.removeItem(LOGOUT_SUPPRESSION_KEY); beginIframeHandshake(); }}>
            Continue with Universe
          </Button>
          {ENABLE_MANUAL_LOGIN && (
            <form className="space-y-3 border-t pt-4" onSubmit={submitManual}>
              <Label htmlFor="accessToken">Development OIDC token</Label>
              <Input id="accessToken" value={manualToken} onChange={(event) => setManualToken(event.target.value)} required />
              <Button type="submit" variant="secondary" className="w-full">Development sign in</Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
