'use client';

import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Loader2, TestTube, Pencil } from 'lucide-react';
import AuthLink from '@/app/admin/auth-link';
import { isVisionCapableModel, resolveVisionSupport } from '@/lib/vision-models';
import { EmptyCard, EntityRow, LoadError, LoadingRows, PageHeader, SectionHeader, StatLine } from '../../components/ds';
import { EnabledPill, providerTypeLabel } from '../components/provider-state';
import { useReplacePage } from '@/app/admin/orbit-frame-context';

interface Bot {
  id: string;
  name: string;
  enabled: boolean;
  room: {
    id: string;
    name: string;
    world: {
      id: string;
      name: string;
      universe: {
        id: string;
        name: string;
      };
    };
  };
}

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
  supportsVision: boolean | null;
  visionModel: string | null;
  defaultVision: boolean;
  settings: Record<string, unknown> | null;
  tested: boolean;
  testedAt: string | null;
  createdAt: string;
  updatedAt: string;
  bots?: Bot[];
}

export default function ProviderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const replacePage = useReplacePage();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  async function fetchProvider() {
    if (!providerId) return;
    
    try {
      setLoading(true);
      setError(null);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/ai-providers/${providerId}`);

      if (!response.ok) {
        if (response.status === 404) {
          replacePage('/admin/ai-providers');
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

  if (loading && !provider) {
    return (
      <div className="grid min-w-0 gap-6">
        <PageHeader kind="provider" title="AI provider" />
        <LoadingRows label="the provider" rows={3} />
      </div>
    );
  }

  if (!provider) {
    return (
      <div className="grid min-w-0 gap-6">
        <PageHeader kind="provider" title="AI provider" />
        {error ? (
          <LoadError label="this provider" retry={fetchProvider} />
        ) : (
          <EmptyCard kind="provider" title="Provider not found." text="It may have been deleted." href="/admin/ai-providers" action="All AI providers" />
        )}
      </div>
    );
  }

  const seesImages = resolveVisionSupport(provider.model || '', provider.supportsVision);

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        kind="provider"
        title={provider.name}
        context={<StatLine items={[providerTypeLabel(provider.type), provider.model]} />}
        status={<EnabledPill enabled={provider.enabled} />}
        actions={
          <>
            <Button asChild className="h-11">
              <AuthLink href={`/admin/ai-providers/${providerId}/edit`}>
                <Pencil className="mr-2 h-4 w-4" />
                Edit
              </AuthLink>
            </Button>
            <Button onClick={handleTest} disabled={testing} variant="outline" className="h-11">
              {testing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Testing...
                </>
              ) : (
                <>
                  <TestTube className="mr-2 h-4 w-4" />
                  Test connection
                </>
              )}
            </Button>
          </>
        }
      />

      {error && <LoadError label="the latest details" retry={fetchProvider} />}

      {testResult && (
        <Alert variant={testResult.success ? 'default' : 'destructive'} role="status">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            <div className="font-semibold">
              {testResult.success ? 'Connection works.' : `Test failed: ${testResult.error || 'Unknown error'}`}
            </div>
            {testResult.details && <div className="mt-1 text-sm">{testResult.details}</div>}
          </AlertDescription>
        </Alert>
      )}

      <section aria-labelledby="provider-settings" className="min-w-0">
        <SectionHeader id="provider-settings" title="Settings" />
        <div className="rounded-2xl border bg-card p-4 sm:p-5">
          <dl className="grid min-w-0 grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <Field label="Type">{providerTypeLabel(provider.type)}</Field>
            <Field label="Model">{provider.model || 'Not set'}</Field>
            <Field label="Endpoint" mono>{provider.endpoint || 'Not set'}</Field>
            <Field label="API key">{provider.apiKeyEncrypted ? '••••••••' : 'Not set'}</Field>
            {provider.temperature !== null && <Field label="Temperature">{provider.temperature}</Field>}
            {provider.maxTokens !== null && <Field label="Max tokens">{provider.maxTokens}</Field>}
            <Field label="Streaming">{provider.supportsStreaming ? 'Yes' : 'No'}</Field>
            <Field label="Vision">
              {seesImages ? 'Vision-capable' : 'Text-only'}
              <span className="text-xs text-muted-foreground">
                {provider.supportsVision === null
                  ? ` (auto${provider.model && isVisionCapableModel(provider.model) ? ' — detected from model name' : ''})`
                  : ' (manually forced)'}
              </span>
            </Field>
            {provider.visionModel && <Field label="Vision model">{provider.visionModel}</Field>}
            {provider.defaultVision && <Field label="Default vision provider">Yes — used automatically to describe images</Field>}
            <Field label="Last tested">
              {provider.tested && provider.testedAt ? new Date(provider.testedAt).toLocaleString() : 'Not tested yet'}
            </Field>
            <Field label="Provider key" mono>{provider.providerId}</Field>
          </dl>
          <p className="mt-4 text-xs text-muted-foreground">
            Test connection checks that the endpoint is reachable and the key is valid.
          </p>
        </div>
      </section>

      {provider.settings && Object.keys(provider.settings).length > 0 && (
        <section aria-labelledby="provider-extra" className="min-w-0">
          <SectionHeader id="provider-extra" title="Extra settings" />
          <pre className="overflow-auto rounded-2xl border bg-muted p-4 text-sm">
            {JSON.stringify(provider.settings, null, 2)}
          </pre>
        </section>
      )}

      <section aria-labelledby="provider-bots" className="min-w-0">
        <SectionHeader id="provider-bots" title="Bots using it" count={provider.bots?.length ?? 0} />
        {!provider.bots || provider.bots.length === 0 ? (
          <p className="text-sm text-muted-foreground">No bots use this provider.</p>
        ) : (
          <div className="grid min-w-0 gap-0.5">
            {provider.bots.map((bot) => (
              <EntityRow
                key={bot.id}
                href={`/admin/bots/${bot.id}`}
                kind="bot"
                title={bot.name}
                context={
                  <StatLine items={[`In ${bot.room.world.universe.name} › ${bot.room.world.name} › ${bot.room.name}`]} />
                }
                meta={<span className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{bot.id}</span>}
                aside={<EnabledPill enabled={bot.enabled} />}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Field({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? 'mt-0.5 font-mono text-xs [overflow-wrap:anywhere]' : 'mt-0.5 [overflow-wrap:anywhere]'}>{children}</dd>
    </div>
  );
}
