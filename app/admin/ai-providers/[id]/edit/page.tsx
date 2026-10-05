'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Loader2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadError, LoadingRows, PageHeader, SettingSwitch, Settings } from '../../../components/ds';
import { VisionConfigSection } from '../../components/VisionConfigSection';
import {
  fromVisionMode,
  toVisionMode,
  type VisionSupportMode,
} from '@/lib/vision-models';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useReplacePage } from '@/app/admin/orbit-frame-context';

const PROVIDER_TYPES = [
  { value: 'lmstudio', label: 'LMStudio' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'ultravox', label: 'Ultravox' },
  { value: 'gpt-voice', label: 'GPT Voice' },
];

export default function EditProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const replacePage = useReplacePage();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string>('');

  const [formData, setFormData] = useState({
    providerId: '',
    name: '',
    type: '',
    enabled: false,
    endpoint: '',
    apiKey: '', // Empty - user must re-enter to change
    model: '',
    temperature: '0.7',
    maxTokens: '500',
    supportsStreaming: true,
    supportsVision: 'auto' as VisionSupportMode,
    visionModel: '',
    defaultVision: false,
  });

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
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/ai-providers/${providerId}`);

      if (!response.ok) {
        if (response.status === 404) {
          replacePage('/admin/ai-providers');
          return;
        }
        throw new Error('Failed to fetch provider');
      }

      const provider = await response.json();
      setFormData({
        providerId: provider.providerId,
        name: provider.name,
        type: provider.type,
        enabled: provider.enabled,
        endpoint: provider.endpoint || '',
        apiKey: '', // Don't show existing encrypted key
        model: provider.model || '',
        temperature: provider.temperature?.toString() || '0.7',
        maxTokens: provider.maxTokens?.toString() || '500',
        supportsStreaming: provider.supportsStreaming ?? true,
        supportsVision: toVisionMode(provider.supportsVision),
        visionModel: provider.visionModel || '',
        defaultVision: provider.defaultVision || false,
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const updateData: Record<string, unknown> = {
        name: formData.name,
        type: formData.type,
        enabled: formData.enabled,
        endpoint: formData.endpoint || null,
        model: formData.model || null,
        temperature: formData.temperature ? parseFloat(formData.temperature) : 0.7,
        maxTokens: formData.maxTokens ? parseInt(formData.maxTokens) : 500,
        supportsStreaming: formData.supportsStreaming,
        supportsVision: fromVisionMode(formData.supportsVision),
        visionModel: formData.visionModel || null,
        defaultVision: formData.defaultVision,
      };

      // Only include API key if user provided a new one
      if (formData.apiKey.trim() !== '') {
        updateData.apiKey = formData.apiKey;
      }

      const response = await authenticatedFetch(`/api/admin/ai-providers/${providerId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updateData),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to update provider');
      }

      replacePage(`/admin/ai-providers/${providerId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/ai-providers/${providerId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete provider');
      }

      replacePage('/admin/ai-providers');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  }

  if (loading) {
    return (
      <div className="grid min-w-0 gap-6">
        <PageHeader kind="provider" title="Edit AI provider" />
        <LoadingRows label="the provider" rows={4} />
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        kind="provider"
        title="Edit AI provider"
      />

      {error && !formData.providerId && <LoadError label="this provider" retry={fetchProvider} />}

      {formData.providerId && (
      <div className="rounded-2xl border bg-card p-4 sm:p-5">
        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="providerId">Provider key</Label>
              <Input id="providerId" className="h-11 font-mono" value={formData.providerId} disabled />
              <p className="text-xs text-muted-foreground">Can’t be changed.</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                className="h-11"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="type">Type *</Label>
              <Select
                value={formData.type}
                onValueChange={(value) => setFormData({ ...formData, type: value })}
                required
              >
                <SelectTrigger id="type" className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="endpoint">Endpoint</Label>
              <Input
                id="endpoint"
                className="h-11"
                value={formData.endpoint}
                onChange={(e) => setFormData({ ...formData, endpoint: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="apiKey">API key</Label>
              <Input
                id="apiKey"
                className="h-11"
                type="password"
                value={formData.apiKey}
                onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                placeholder="Enter a new key to replace it"
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to keep the saved key.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="model">Model</Label>
              <Input
                id="model"
                className="h-11"
                value={formData.model}
                onChange={(e) => setFormData({ ...formData, model: e.target.value })}
              />
            </div>

            <div className="md:col-span-2">
            <VisionConfigSection
              value={{
                model: formData.model,
                supportsVision: formData.supportsVision,
                visionModel: formData.visionModel,
                defaultVision: formData.defaultVision,
              }}
              onChange={(patch) => setFormData({ ...formData, ...patch })}
            />
            </div>

            <div className="space-y-2">
              <Label htmlFor="temperature">Temperature</Label>
              <Input
                id="temperature"
                className="h-11"
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={formData.temperature}
                onChange={(e) => setFormData({ ...formData, temperature: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="maxTokens">Max tokens</Label>
              <Input
                id="maxTokens"
                className="h-11"
                type="number"
                min="1"
                value={formData.maxTokens}
                onChange={(e) => setFormData({ ...formData, maxTokens: e.target.value })}
              />
            </div>
          </div>

          <Settings label="Behaviour">
            <SettingSwitch
              id="supportsStreaming"
              label="Streaming"
              hint="Replies arrive word by word. Off: each reply arrives whole."
              checked={formData.supportsStreaming}
              onChange={(checked) => setFormData({ ...formData, supportsStreaming: checked })}
            />
            <SettingSwitch
              id="enabled"
              label="Enabled"
              hint="Bots can use this provider. Off: it stays saved but no bot can use it."
              checked={formData.enabled}
              onChange={(checked) => setFormData({ ...formData, enabled: checked })}
            />
          </Settings>

          <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:items-center">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="outline" className="h-11 text-destructive hover:text-destructive sm:mr-auto">
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete provider
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {formData.name || 'this provider'}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently deletes the provider. It can’t be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Button type="button" variant="outline" className="h-11" asChild>
              <Link href={`/admin/ai-providers/${providerId}`}>Cancel</Link>
            </Button>
            <Button type="submit" className="h-11" disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save changes'
              )}
            </Button>
          </div>
        </form>
      </div>
      )}
    </div>
  );
}

