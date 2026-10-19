'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { BarChart3, Loader2, Plus, Sparkles } from 'lucide-react';
import { EmptyCard, EntityRow, LoadError, LoadingRows, PageHeader, StatLine, count } from '../components/ds';
import { FormSheet } from '../components/form-sheet';
import { EnabledPill, providerTypeLabel } from './components/provider-state';
import { useReplacePage } from '@/app/admin/orbit-frame-context';
import { useToast } from '@/components/ui/toast';

interface AiProvider {
  providerId: string;
  name: string;
  type: string;
  enabled: boolean;
  endpoint: string | null;
  model: string | null;
  tested: boolean;
  testedAt: string | null;
  defaultVision?: boolean;
  /** The one Universe AI runs on. */
  isDefault?: boolean;
  /** Bots pinned to this provider by its id. */
  pinnedBots?: number;
  /** Bots on Universe AI (only counted on the default). */
  universeAiBots?: number;
  createdAt: string;
  updatedAt: string;
}

export default function AiProvidersPage() {
  const router = useRouter();
  const replacePage = useReplacePage();
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const { addToast } = useToast();
  const [makingDefault, setMakingDefault] = useState<AiProvider | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    checkAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkAuth() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }
      const userData = await response.json();
      if (!userData.user?.isSuperAdmin) {
        replacePage('/admin');
        return;
      }
      fetchProviders();
    } catch {
      router.push('/admin/login');
    }
  }

  async function fetchProviders() {
    try {
      setLoading(true);
      setError(null);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/ai-providers');

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          replacePage('/admin');
          return;
        }
        throw new Error('Failed to fetch providers');
      }

      const data = await response.json();
      setProviders(data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleEnabled(providerId: string, currentEnabled: boolean) {
    setToggling(providerId);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/ai-providers/${providerId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled: !currentEnabled }),
      });

      if (!response.ok) {
        throw new Error('Failed to update provider');
      }

      fetchProviders();
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setToggling(null);
    }
  }

  async function makeDefault(provider: AiProvider) {
    setBusy(true);
    setFailure(null);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/ai-providers/${provider.providerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDefault: true }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || 'That didn’t work. Try again.');
      }
      setMakingDefault(null);
      addToast({ description: `${provider.name} is now the default`, variant: 'success', duration: 2500 });
      fetchProviders();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const onUniverseAi = providers.reduce((total, provider) => total + (provider.universeAiBots ?? 0), 0);
  const pinned = providers.reduce((total, provider) => total + (provider.pinnedBots ?? 0), 0);

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        icon={<Sparkles size={30} aria-hidden="true" />}
        title="Universe AI"
        context={
          <span className="text-sm text-muted-foreground">
            What bots run on unless their maker lends a key. People see one choice, Universe AI: it uses the default below.
          </span>
        }
        actions={
          <>
            <Button asChild className="h-11">
              <Link href="/admin/ai-providers/new">
                <Plus className="mr-2 h-4 w-4" />
                New provider
              </Link>
            </Button>
            <Button asChild variant="outline" className="h-11">
              <Link href="/admin/ai-providers/usage">
                <BarChart3 className="mr-2 h-4 w-4" />
                AI usage
              </Link>
            </Button>
          </>
        }
      />

      {error && <LoadError label="AI providers" retry={fetchProviders} />}

      {loading && providers.length === 0 ? (
        <LoadingRows label="AI providers" rows={3} />
      ) : providers.length === 0 ? (
        !error && (
          <EmptyCard
            kind="provider"
            title="No AI providers yet."
            text="Add one so bots have a model to talk through."
            href="/admin/ai-providers/new"
            action="New provider"
          />
        )
      ) : (
        <div className="grid min-w-0 gap-0.5">
          {providers.map((provider) => (
            <EntityRow
              key={provider.providerId}
              href={`/admin/ai-providers/${provider.providerId}`}
              kind="provider"
              title={provider.name}
              chevron={provider.isDefault}
              titleAside={provider.isDefault && <DefaultPill />}
              context={
                <StatLine
                  items={[
                    providerTypeLabel(provider.type),
                    provider.model,
                    botsLine(provider),
                    provider.defaultVision && 'Describes pictures',
                    provider.tested && provider.testedAt && `tested ${new Date(provider.testedAt).toLocaleDateString()}`,
                  ]}
                />
              }
              meta={provider.endpoint && <span className="truncate text-xs text-muted-foreground">{provider.endpoint}</span>}
              aside={<EnabledPill enabled={provider.enabled} />}
              trailing={
                // The default can't be turned off: Universe AI always has one
                provider.isDefault ? null : (
                  <>
                    {provider.enabled && (
                      <Button
                        variant="outline"
                        className="h-11"
                        onClick={() => {
                          setFailure(null);
                          setMakingDefault(provider);
                        }}
                        aria-label={`Make ${provider.name} the default`}
                      >
                        Make default
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      className="h-11"
                      disabled={toggling === provider.providerId}
                      onClick={() => handleToggleEnabled(provider.providerId, provider.enabled)}
                      aria-label={`${provider.enabled ? 'Disable' : 'Enable'} ${provider.name}`}
                    >
                      {toggling === provider.providerId && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {provider.enabled ? 'Disable' : 'Enable'}
                    </Button>
                  </>
                )
              }
            />
          ))}
        </div>
      )}

      <FormSheet
        open={makingDefault !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setMakingDefault(null);
        }}
        title={makingDefault ? `Make ${makingDefault.name} the default?` : 'Make the default?'}
      >
        <p className="text-sm text-muted-foreground">
          {onUniverseAi > 0
            ? `The ${count(onUniverseAi, 'bot')} on Universe AI switch to it on their next reply.`
            : 'Bots on Universe AI switch to it on their next reply.'}{' '}
          {pinned > 0 ? `The ${count(pinned, 'bot')} pinned to a provider` : 'Bots pinned to a provider'} keep theirs, and so do bots on
          their makers’ keys.
        </p>
        {failure && (
          <p role="alert" className="text-sm text-[#fca5a5]">
            {failure}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" className="h-11 px-5" disabled={busy} onClick={() => setMakingDefault(null)}>
            Cancel
          </Button>
          <Button className="h-11 px-5" disabled={busy} onClick={() => makingDefault && void makeDefault(makingDefault)}>
            {busy ? 'Saving…' : 'Make default'}
          </Button>
        </div>
      </FormSheet>
    </div>
  );
}

/** "31 bots" on the default (pinned ones and the bots on Universe AI), "2 bots pinned" on the others. */
function botsLine(provider: AiProvider): string | null {
  const bots = (provider.pinnedBots ?? 0) + (provider.universeAiBots ?? 0);
  if (bots === 0) return null;
  return `${count(bots, 'bot')}${provider.isDefault ? '' : ' pinned'}`;
}

/** Which provider Universe AI runs on: a neutral outline pill (the standard keeps gradient for "on" and violet for "picked"). */
function DefaultPill() {
  return (
    <span className="inline-flex h-[22px] items-center whitespace-nowrap rounded-full border border-foreground/15 px-2.5 text-[11px] font-semibold text-foreground/85">
      Default
    </span>
  );
}
