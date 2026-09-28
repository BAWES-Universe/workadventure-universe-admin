'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Loader2, Users, Upload, Trash2, Save } from 'lucide-react';
import SpriteSheetPreview from '@/components/sprite-preview';
import { LoadError, LoadingRows, PageHeader, SettingSwitch, StatLine } from '../../../../components/ds';
import { Pill } from '../../../components/set-pills';

const LAYER_TYPES = ['woka', 'body', 'eyes', 'hair', 'clothes', 'hat', 'accessory'];

interface LayerData {
  id: string;
  textureId: string;
  name: string | null;
  layer: string;
  url: string;
  position: number;
  isActive: boolean;
}

export default function LayerDetailPage() {
  const router = useRouter();
  const params = useParams();
  const setId = params?.id as string;
  const layerId = params?.layerId as string;

  const [checkingAuth, setCheckingAuth] = useState(true);
  const [layer, setLayer] = useState<LayerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Edit form state
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [layerType, setLayerType] = useState('body');
  const [position, setPosition] = useState(0);
  const [isActive, setIsActive] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);

  // Usage stats
  const [usageCount, setUsageCount] = useState<number | null>(null);

  useEffect(() => {
    setCheckingAuth(false);
  }, []);

  async function fetchLayer() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const res = await authenticatedFetch(`/api/admin/avatar-sets/${setId}/layers/${layerId}`);
      if (!res.ok) throw new Error('Not found');
      const data = await res.json();
      setLayer(data);
      setName(data.name || data.textureId);
      setUrl(data.url);
      setLayerType(data.layer);
      setPosition(data.position);
      setIsActive(data.isActive);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (checkingAuth) return;
    fetchLayer();
  }, [checkingAuth]);

  // Fetch usage count
  useEffect(() => {
    if (!layerId) return;
    (async () => {
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const res = await authenticatedFetch(`/api/admin/texture-usage?textureId=${layer?.textureId}&type=layer`);
        if (res.ok) {
          const data = await res.json();
          setUsageCount(data.userCount);
        }
      } catch {}
    })();
  }, [layer?.textureId]);

  async function handleSave() {
    if (!layer) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const res = await authenticatedFetch(`/api/admin/avatar-sets/${setId}/layers/${layerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name === layer.name ? undefined : name,
          url: url === layer.url ? undefined : url,
          layer: layerType === layer.layer ? undefined : layerType,
          position: position === layer.position ? undefined : position,
          isActive: isActive === layer.isActive ? undefined : isActive,
        }),
      });
      if (!res.ok) throw new Error('Failed to save');
      setSuccess('Saved');
      await fetchLayer();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!layer) return;
    if (!confirm(`Delete "${layer.name || layer.textureId}"? This cannot be undone.`)) return;
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      await authenticatedFetch(`/api/admin/avatar-sets/${setId}/layers/${layerId}`, { method: 'DELETE' });
      router.push(`/admin/avatars/${setId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const formData = new FormData();
      formData.append('file', file);
      formData.append('setId', setId);
      formData.append('textureId', layer?.textureId || '');
      const res = await authenticatedFetch('/api/admin/avatar-sets/upload-texture', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Upload failed');
      }
      const data = await res.json();
      setUrl(data.url);
      setSuccess('Texture uploaded. Click Save to apply.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    }
  }

  const retry = () => { setError(null); setLoading(true); fetchLayer(); };

  if (checkingAuth || loading) {
    return (
      <div className="grid min-w-0 gap-6">
        <PageHeader kind="avatar" title="Layer" />
        <LoadingRows label="the layer" rows={3} />
      </div>
    );
  }

  if (error && !layer) {
    return (
      <div className="grid min-w-0 gap-6">
        <PageHeader kind="avatar" title="Layer" />
        <LoadError label="this layer" retry={retry} />
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        kind="avatar"
        title={layer?.name || layer?.textureId || 'Layer'}
        context={<StatLine items={['Layer', layer?.layer]} />}
        status={
          layer && (
            <Pill>
              <i aria-hidden="true" className={layer.isActive ? 'h-1.5 w-1.5 rounded-full bg-green-500' : 'h-1.5 w-1.5 rounded-full bg-muted-foreground/50'} />
              {layer.isActive ? 'Active' : 'Inactive'}
            </Pill>
          )
        }
        actions={
          <>
            <Button className="h-11" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save
            </Button>
            <Button variant="outline" className="h-11 text-destructive hover:text-destructive" onClick={handleDelete}>
              <Trash2 className="mr-2 h-4 w-4" /> Delete
            </Button>
          </>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {success && (
        <p className="text-sm text-muted-foreground" role="status">{success}</p>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-6 md:grid-cols-2">
        {/* Spritesheet preview */}
        <section aria-labelledby="sprite-sheet" className="min-w-0 rounded-2xl border bg-card p-4 sm:p-5">
          <h2 id="sprite-sheet" className="orbit-display mb-4 text-base font-semibold">Sprite sheet</h2>
          <div className="flex flex-col items-center">
            {layer && <SpriteSheetPreview url={layer.url} large />}
          </div>
          <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <Users className="h-4 w-4" aria-hidden="true" />
            {usageCount !== null ? (
              <span>
                <strong className="text-foreground">{usageCount.toLocaleString()}</strong> {usageCount === 1 ? 'person has' : 'people have'} this equipped
              </span>
            ) : (
              'Counting who has it equipped...'
            )}
          </p>
        </section>

        {/* Form controls */}
        <section aria-labelledby="texture-details" className="grid min-w-0 content-start gap-4 rounded-2xl border bg-card p-4 sm:p-5">
          <h2 id="texture-details" className="orbit-display text-base font-semibold">Details</h2>
          <div className="space-y-2">
            <Label htmlFor="texture-name">Name</Label>
            <Input id="texture-name" value={name} onChange={e => setName(e.target.value)} className="h-11" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="texture-url">Image URL</Label>
            <div className="flex gap-2">
              <Input
                id="texture-url"
                value={url}
                onChange={e => setUrl(e.target.value)}
                className="h-11 flex-1 font-mono text-xs"
                placeholder="http://... or S3 URL"
              />
              <Button type="button" variant="outline" className="h-11 shrink-0" onClick={() => fileInput.current?.click()}>
                <Upload className="mr-2 h-4 w-4" />
                Upload
              </Button>
              <input ref={fileInput} type="file" accept="image/*" onChange={handleUpload} className="hidden" tabIndex={-1} aria-hidden="true" />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="texture-layer">Layer type</Label>
            <Select value={layerType} onValueChange={setLayerType}>
              <SelectTrigger id="texture-layer" className="h-11 capitalize">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LAYER_TYPES.map(t => (
                  <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="texture-position">Position</Label>
            <Input
              id="texture-position"
              type="number"
              min={0}
              value={position}
              onChange={e => setPosition(parseInt(e.target.value) || 0)}
              className="h-11 w-24 text-center"
            />
          </div>

          <SettingSwitch
            id="texture-active"
            label="Active"
            hint="Players can pick it. Off: it stays in the set but isn’t offered."
            checked={isActive}
            onChange={setIsActive}
          />

          <p className="text-xs text-muted-foreground">
            Texture key <code className="rounded bg-muted px-1 font-mono text-foreground">{layer?.textureId}</code>
          </p>
        </section>
      </div>
    </div>
  );
}
