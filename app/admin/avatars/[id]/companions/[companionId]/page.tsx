'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Loader2, Users, Upload, Trash2, Save } from 'lucide-react';
import SpriteSheetPreview from '@/components/sprite-preview';
import { LoadError, LoadingRows, PageHeader, SettingSwitch, StatLine } from '../../../../components/ds';
import { Pill } from '../../../components/set-pills';
import { useReplacePage } from '@/app/admin/orbit-frame-context';

const COMPANION_BEHAVIORS = [
  { value: 'none', label: 'None' },
  { value: 'cat', label: 'Cat' },
  { value: 'dog', label: 'Dog' },
  { value: 'red_panda', label: 'Red Panda' },
];

interface CompanionData {
  id: string;
  textureId: string;
  name: string | null;
  url: string;
  behavior: string | null;
  position: number;
  isActive: boolean;
}

export default function CompanionDetailPage() {
  const replacePage = useReplacePage();
  const params = useParams();
  const setId = params?.id as string;
  const companionId = params?.companionId as string;

  const [checkingAuth, setCheckingAuth] = useState(true);
  const [companion, setCompanion] = useState<CompanionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Edit form state
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [behavior, setBehavior] = useState('');
  const [position, setPosition] = useState(0);
  const [isActive, setIsActive] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);

  // Usage stats
  const [usageCount, setUsageCount] = useState<number | null>(null);

  useEffect(() => {
    // Check auth by fetching the resource; redirect on 401
    setCheckingAuth(false);
  }, []);

  async function fetchCompanion() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const res = await authenticatedFetch(`/api/admin/avatar-sets/${setId}/companions/${companionId}`);
      if (!res.ok) throw new Error('Not found');
      const data = await res.json();
      setCompanion(data);
      setName(data.name || data.textureId);
      setUrl(data.url);
      setBehavior(data.behavior || '');
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
    fetchCompanion();
  }, [checkingAuth]);

  // Fetch usage count
  useEffect(() => {
    if (!companion) return;
    (async () => {
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const res = await authenticatedFetch(`/api/admin/texture-usage?textureId=${companion.textureId}&type=companion`);
        if (res.ok) {
          const data = await res.json();
          setUsageCount(data.userCount);
        }
      } catch {}
    })();
  }, [companion?.textureId]);

  async function handleSave() {
    if (!companion) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const res = await authenticatedFetch(`/api/admin/avatar-sets/${setId}/companions/${companionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name === companion.name ? undefined : name,
          url: url === companion.url ? undefined : url,
          behavior: (behavior || null) === companion.behavior ? undefined : (behavior || null),
          position: position === companion.position ? undefined : position,
          isActive: isActive === companion.isActive ? undefined : isActive,
        }),
      });
      if (!res.ok) throw new Error('Failed to save');
      setSuccess('Saved');
      await fetchCompanion();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!companion) return;
    if (!confirm(`Delete companion "${companion.name || companion.textureId}"? This cannot be undone.`)) return;
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      await authenticatedFetch(`/api/admin/avatar-sets/${setId}/companions/${companionId}`, { method: 'DELETE' });
      replacePage(`/admin/avatars/${setId}`);
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
      formData.append('textureId', companion?.textureId || '');
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

  const retry = () => { setError(null); setLoading(true); fetchCompanion(); };

  if (checkingAuth || loading) {
    return (
      <div className="grid min-w-0 gap-6">
        <PageHeader kind="avatar" title="Companion" />
        <LoadingRows label="the companion" rows={3} />
      </div>
    );
  }

  if (error && !companion) {
    return (
      <div className="grid min-w-0 gap-6">
        <PageHeader kind="avatar" title="Companion" />
        <LoadError label="this companion" retry={retry} />
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        kind="avatar"
        title={companion?.name || companion?.textureId || 'Companion'}
        context={<StatLine items={['Companion', companion?.behavior && (COMPANION_BEHAVIORS.find(b => b.value === companion.behavior)?.label ?? companion.behavior)]} />}
        status={
          companion && (
            <Pill>
              <i aria-hidden="true" className={companion.isActive ? 'h-1.5 w-1.5 rounded-full bg-green-500' : 'h-1.5 w-1.5 rounded-full bg-muted-foreground/50'} />
              {companion.isActive ? 'Active' : 'Inactive'}
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
            {companion && <SpriteSheetPreview url={companion.url} large />}
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
            <Label htmlFor="texture-behavior">Behavior</Label>
            <Select value={behavior} onValueChange={setBehavior}>
              <SelectTrigger id="texture-behavior" className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMPANION_BEHAVIORS.map(b => (
                  <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>
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
            Texture key <code className="rounded bg-muted px-1 font-mono text-foreground">{companion?.textureId}</code>
          </p>
        </section>
      </div>
    </div>
  );
}
