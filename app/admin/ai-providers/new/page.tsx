'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader, SettingSwitch, Settings } from '../../components/ds';
import { VisionConfigSection } from '../components/VisionConfigSection';
import {
  fromVisionMode,
  type VisionSupportMode,
} from '@/lib/vision-models';

const PROVIDER_TYPES = [
  { value: 'lmstudio', label: 'LMStudio' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'ultravox', label: 'Ultravox' },
  { value: 'gpt-voice', label: 'GPT Voice' },
];

export default function NewProviderPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    providerId: '',
    name: '',
    type: '',
    enabled: false,
    endpoint: '',
    apiKey: '',
    model: '',
    temperature: '0.7',
    maxTokens: '500',
    supportsStreaming: true,
    supportsVision: 'auto' as VisionSupportMode,
    visionModel: '',
    defaultVision: false,
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/ai-providers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...formData,
          temperature: formData.temperature ? parseFloat(formData.temperature) : 0.7,
          maxTokens: formData.maxTokens ? parseInt(formData.maxTokens) : 500,
          supportsVision: fromVisionMode(formData.supportsVision),
          visionModel: formData.visionModel || null,
          defaultVision: formData.defaultVision,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create provider');
      }

      router.push('/admin/ai-providers');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        kind="provider"
        title="New AI provider"
        context={<span className="text-sm text-muted-foreground">A model endpoint bots can talk through.</span>}
      />

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
              <Label htmlFor="providerId">Provider key *</Label>
              <Input
                id="providerId"
                className="h-11"
                value={formData.providerId}
                onChange={(e) => setFormData({ ...formData, providerId: e.target.value })}
                placeholder="e.g., lmstudio-local"
                required
              />
              <p className="text-xs text-muted-foreground">
                Lowercase, no spaces. Bots refer to the provider by this; it can’t change later.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                className="h-11"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., LMStudio Local"
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
                  <SelectValue placeholder="Select provider type" />
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
                placeholder="e.g., http://localhost:1234"
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
                placeholder="Will be encrypted on save"
              />
              <p className="text-xs text-muted-foreground">
                Stored encrypted. Leave empty for providers that don’t need one (LMStudio, say).
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="model">Model</Label>
              <Input
                id="model"
                className="h-11"
                value={formData.model}
                onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                placeholder="e.g., gpt-4, claude-3-haiku"
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

          <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="h-11" asChild>
              <Link href="/admin/ai-providers">Cancel</Link>
            </Button>
            <Button type="submit" className="h-11" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create provider'
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

