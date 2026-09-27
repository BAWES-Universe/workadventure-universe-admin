'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { BarChart3, Loader2, Plus } from 'lucide-react';
import { EmptyCard, EntityRow, LoadError, LoadingRows, PageHeader, StatLine } from '../components/ds';
import { EnabledPill, providerTypeLabel } from './components/provider-state';

interface AiProvider {
  providerId: string;
  name: string;
  type: string;
  enabled: boolean;
  endpoint: string | null;
  model: string | null;
  tested: boolean;
  testedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export default function AiProvidersPage() {
  const router = useRouter();
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

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
        router.push('/admin');
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
          router.push('/admin');
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

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        kind="provider"
        title="AI providers"
        context={<span className="text-sm text-muted-foreground">The models your bots talk through.</span>}
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
              context={
                <StatLine
                  items={[
                    providerTypeLabel(provider.type),
                    provider.model,
                    provider.tested && provider.testedAt && `tested ${new Date(provider.testedAt).toLocaleDateString()}`,
                  ]}
                />
              }
              meta={provider.endpoint && <span className="truncate text-xs text-muted-foreground">{provider.endpoint}</span>}
              aside={<EnabledPill enabled={provider.enabled} />}
              trailing={
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
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
