'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Loader2, ArrowLeft, TestTube, Edit, CheckCircle2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';

interface AiProvider {
  providerId: string;
  name: string;
  type: string;
  enabled: boolean;
  endpoint: string | null;
  apiKeyEncrypted: string | null;
  model: string | null;
  temperature: number | null;
  maxTokens: number | null;
  supportsStreaming: boolean;
  settings: any;
  tested: boolean;
  testedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export default function ProviderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string; details?: string } | null>(null);
  const [providerId, setProviderId] = useState<string>('');
  const [provider, setProvider] = useState<AiProvider | null>(null);

  useEffect(() => {
    params.then((p) => {
      setProviderId(p.id);
    });
  }, [params]);

  useEffect(() => {
    if (providerId) {
      fetchProvider();
    }
  }, [providerId]);

  async function fetchProvider() {
    if (!providerId) return;
    
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/ai-providers/${providerId}`);

      if (!response.ok) {
        if (response.status === 404) {
          router.push('/admin/ai-providers');
          return;
        }
        throw new Error('Failed to fetch provider');
      }

      const data = await response.json();
      setProvider(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  async function handleTest() {
    try {
      setTesting(true);
      setTestResult(null);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/ai-providers/${providerId}/test`, {
        method: 'POST',
      });

      const result = await response.json();
      setTestResult(result);

      if (result.success) {
        fetchProvider(); // Refresh to update tested status
      }
    } catch (err) {
      setTestResult({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (!provider) {
    return (
      <div className="space-y-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Provider not found</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/admin/ai-providers">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-4xl font-bold tracking-tight">{provider.name}</h1>
            <p className="text-muted-foreground text-lg">
              Provider details and configuration
            </p>
          </div>
        </div>
        <Link href={`/admin/ai-providers/${providerId}/edit`}>
          <Button>
            <Edit className="mr-2 h-4 w-4" />
            Edit
          </Button>
        </Link>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {testResult && (
        <Alert variant={testResult.success ? 'default' : 'destructive'}>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {testResult.success ? (
              <div>
                <div className="font-semibold">Connection test successful!</div>
                {testResult.details && (
                  <div className="text-sm mt-1">{testResult.details}</div>
                )}
              </div>
            ) : (
              <div>
                <div className="font-semibold">Test failed: {testResult.error || 'Unknown error'}</div>
                {testResult.details && (
                  <div className="text-sm mt-1">{testResult.details}</div>
                )}
              </div>
            )}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Basic Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="text-sm font-medium text-muted-foreground">Provider ID</div>
              <div className="text-base">{provider.providerId}</div>
            </div>
            <div>
              <div className="text-sm font-medium text-muted-foreground">Name</div>
              <div className="text-base">{provider.name}</div>
            </div>
            <div>
              <div className="text-sm font-medium text-muted-foreground">Type</div>
              <Badge variant="outline">{provider.type}</Badge>
            </div>
            <div>
              <div className="text-sm font-medium text-muted-foreground">Status</div>
              <div className="flex items-center gap-2">
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
            {provider.tested && provider.testedAt && (
              <div>
                <div className="text-sm font-medium text-muted-foreground">Last Tested</div>
                <div className="text-base flex items-center gap-2 text-green-600">
                  <CheckCircle2 className="h-4 w-4" />
                  {new Date(provider.testedAt).toLocaleString()}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {provider.endpoint && (
              <div>
                <div className="text-sm font-medium text-muted-foreground">Endpoint</div>
                <div className="text-base break-all">{provider.endpoint}</div>
              </div>
            )}
            {provider.model && (
              <div>
                <div className="text-sm font-medium text-muted-foreground">Model</div>
                <div className="text-base">{provider.model}</div>
              </div>
            )}
            {provider.temperature !== null && (
              <div>
                <div className="text-sm font-medium text-muted-foreground">Temperature</div>
                <div className="text-base">{provider.temperature}</div>
              </div>
            )}
            {provider.maxTokens !== null && (
              <div>
                <div className="text-sm font-medium text-muted-foreground">Max Tokens</div>
                <div className="text-base">{provider.maxTokens}</div>
              </div>
            )}
            <div>
              <div className="text-sm font-medium text-muted-foreground">Supports Streaming</div>
              <div className="text-base">
                {provider.supportsStreaming ? 'Yes' : 'No'}
              </div>
            </div>
            <div>
              <div className="text-sm font-medium text-muted-foreground">API Key</div>
              <div className="text-base">
                {provider.apiKeyEncrypted ? '••••••••' : 'Not set'}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Connection Test</CardTitle>
            <Button
              onClick={handleTest}
              disabled={testing}
              variant="outline"
            >
              {testing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Testing...
                </>
              ) : (
                <>
                  <TestTube className="mr-2 h-4 w-4" />
                  Test Connection
                </>
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Test the connection to verify that the provider endpoint is reachable and credentials are valid.
          </p>
        </CardContent>
      </Card>

      {provider.settings && Object.keys(provider.settings).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Settings</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-sm bg-muted p-4 rounded-md overflow-auto">
              {JSON.stringify(provider.settings, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

