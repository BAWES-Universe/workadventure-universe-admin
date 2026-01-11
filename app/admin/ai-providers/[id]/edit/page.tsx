'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Loader2, ArrowLeft, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
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

const PROVIDER_TYPES = [
  { value: 'lmstudio', label: 'LMStudio' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'ultravox', label: 'Ultravox' },
  { value: 'gpt-voice', label: 'GPT Voice' },
];

export default function EditProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
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
      const updateData: any = {
        name: formData.name,
        type: formData.type,
        enabled: formData.enabled,
        endpoint: formData.endpoint || null,
        model: formData.model || null,
        temperature: formData.temperature ? parseFloat(formData.temperature) : 0.7,
        maxTokens: formData.maxTokens ? parseInt(formData.maxTokens) : 500,
        supportsStreaming: formData.supportsStreaming,
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

      router.push(`/admin/ai-providers/${providerId}`);
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

      router.push('/admin/ai-providers');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
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

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <Link href={`/admin/ai-providers/${providerId}`}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-4xl font-bold tracking-tight">Edit AI Provider</h1>
          <p className="text-muted-foreground text-lg">
            Update provider configuration
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Provider Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="providerId">Provider ID</Label>
                <Input id="providerId" value={formData.providerId} disabled />
                <p className="text-xs text-muted-foreground">Cannot be changed</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="name">Name *</Label>
                <Input
                  id="name"
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
                  <SelectTrigger>
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
                  value={formData.endpoint}
                  onChange={(e) => setFormData({ ...formData, endpoint: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="apiKey">API Key</Label>
                <Input
                  id="apiKey"
                  type="password"
                  value={formData.apiKey}
                  onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                  placeholder="Leave empty to keep existing key, or enter new key"
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty to keep existing encrypted key
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="model">Model</Label>
                <Input
                  id="model"
                  value={formData.model}
                  onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="temperature">Temperature</Label>
                <Input
                  id="temperature"
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={formData.temperature}
                  onChange={(e) => setFormData({ ...formData, temperature: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="maxTokens">Max Tokens</Label>
                <Input
                  id="maxTokens"
                  type="number"
                  min="1"
                  value={formData.maxTokens}
                  onChange={(e) => setFormData({ ...formData, maxTokens: e.target.value })}
                />
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <Switch
                id="supportsStreaming"
                checked={formData.supportsStreaming}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, supportsStreaming: checked })
                }
              />
              <Label htmlFor="supportsStreaming">Supports Streaming</Label>
            </div>

            <div className="flex items-center space-x-2">
              <Switch
                id="enabled"
                checked={formData.enabled}
                onCheckedChange={(checked) => setFormData({ ...formData, enabled: checked })}
              />
              <Label htmlFor="enabled">Enabled</Label>
            </div>

            <div className="flex gap-4">
              <Button type="submit" disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Save Changes'
                )}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button type="button" variant="destructive">
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete the provider. This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleDelete} className="bg-destructive">
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Link href={`/admin/ai-providers/${providerId}`}>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

