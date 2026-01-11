'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, Loader2, Plus, Settings, CheckCircle2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

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

  useEffect(() => {
    checkAuth();
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
    } catch (err) {
      router.push('/admin/login');
    }
  }

  async function fetchProviders() {
    try {
      setLoading(true);
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
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }


  async function handleToggleEnabled(providerId: string, currentEnabled: boolean) {
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

      fetchProviders(); // Refresh
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  if (loading && providers.length === 0) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-4xl font-bold tracking-tight">AI Providers</h1>
          <p className="text-muted-foreground text-lg">
            Manage AI providers for bot integration
          </p>
        </div>
        <Link href="/admin/ai-providers/new">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            New Provider
          </Button>
        </Link>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            {error}
            <Button
              variant="outline"
              size="sm"
              className="ml-4"
              onClick={fetchProviders}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {providers.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No providers found. Create your first provider to get started.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {providers.map((provider) => (
            <Card
              key={provider.providerId}
              className="group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all hover:-translate-y-1 hover:shadow-lg"
            >
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-purple-500/10 via-transparent to-pink-500/20 opacity-0 transition-opacity group-hover:opacity-100" />
              <CardContent className="relative flex h-full flex-col p-5">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <h3 className="text-base font-semibold leading-tight">
                      {provider.name}
                    </h3>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{provider.type}</Badge>
                      {provider.enabled ? (
                        <Badge variant="default" className="bg-green-600">
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                          Enabled
                        </Badge>
                      ) : (
                        <Badge variant="secondary">
                          <XCircle className="mr-1 h-3 w-3" />
                          Disabled
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mt-auto space-y-2 pt-3 text-xs text-muted-foreground">
                  {provider.endpoint && (
                    <div className="truncate">
                      <span className="font-medium">Endpoint:</span> {provider.endpoint}
                    </div>
                  )}
                  {provider.model && (
                    <div>
                      <span className="font-medium">Model:</span> {provider.model}
                    </div>
                  )}
                  {provider.tested && provider.testedAt && (
                    <div className="flex items-center gap-1.5 text-green-600">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span>Tested {new Date(provider.testedAt).toLocaleDateString()}</span>
                    </div>
                  )}
                </div>

                <div className="mt-4 flex gap-2">
                  <Link
                    href={`/admin/ai-providers/${provider.providerId}`}
                    className="flex-1"
                  >
                    <Button variant="outline" size="sm" className="w-full">
                      <Settings className="mr-2 h-4 w-4" />
                      View Details
                    </Button>
                  </Link>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleToggleEnabled(provider.providerId, provider.enabled)}
                  >
                    {provider.enabled ? 'Disable' : 'Enable'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

