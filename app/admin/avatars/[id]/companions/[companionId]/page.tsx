'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, ArrowLeft, Users, Upload, Trash2, Save } from 'lucide-react';
import SpriteSheetPreview from '@/components/sprite-preview';

const COMPANION_BEHAVIORS = [
  { value: '', label: 'None' },
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
  const router = useRouter();
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

  if (checkingAuth || loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && !companion) {
    return (
      <div className="max-w-lg mx-auto mt-16 text-center">
        <p className="text-red-500 mb-4">{error}</p>
        <Button variant="outline" onClick={() => router.push(`/admin/avatars/${setId}`)}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 py-8 px-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push(`/admin/avatars/${setId}`)}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold">{companion?.name || companion?.textureId}</h1>
          <p className="text-xs text-muted-foreground font-mono">{companion?.textureId}</p>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 text-red-600 text-sm px-4 py-2 rounded-lg">{error}</div>
      )}
      {success && (
        <div className="bg-emerald-500/10 text-emerald-600 text-sm px-4 py-2 rounded-lg">{success}</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Spritesheet preview */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Sprite Sheet</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center">
            {companion && <SpriteSheetPreview url={companion.url} large />}
          </CardContent>
        </Card>

        {/* Controls */}
        <div className="space-y-4">
          {/* Usage stats */}
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Users className="h-4 w-4" />
                Usage
              </CardTitle>
            </CardHeader>
            <CardContent className="py-2">
              {usageCount !== null ? (
                <div>
                  <span className="text-2xl font-bold">{usageCount}</span>
                  <span className="text-sm text-muted-foreground ml-2">users have this equipped</span>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Loading...</p>
              )}
            </CardContent>
          </Card>

          {/* Form */}
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 py-2">
              {/* Name */}
              <div className="space-y-1">
                <Label className="text-xs">Name</Label>
                <Input value={name} onChange={e => setName(e.target.value)} className="h-9 text-sm" />
              </div>

              {/* URL */}
              <div className="space-y-1">
                <Label className="text-xs">URL</Label>
                <div className="flex gap-2">
                  <Input
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    className="h-9 text-xs font-mono flex-1"
                    placeholder="http://... or S3 URL"
                  />
                  <label className="cursor-pointer">
                    <Button variant="outline" size="icon" className="h-9 w-9" asChild>
                      <span><Upload className="h-4 w-4" /></span>
                    </Button>
                    <input type="file" accept="image/*" onChange={handleUpload} className="hidden" />
                  </label>
                </div>
              </div>

              {/* Behavior */}
              <div className="space-y-1">
                <Label className="text-xs">Behavior</Label>
                <Select value={behavior} onValueChange={setBehavior}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COMPANION_BEHAVIORS.map(b => (
                      <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Position */}
              <div className="space-y-1">
                <Label className="text-xs">Position</Label>
                <Input
                  type="number"
                  min={0}
                  value={position}
                  onChange={e => setPosition(parseInt(e.target.value) || 0)}
                  className="h-9 w-20 text-center"
                />
              </div>

              {/* Active toggle */}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={e => setIsActive(e.target.checked)}
                  className="rounded border-border"
                />
                <span className="text-xs">Active</span>
              </label>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 justify-end">
        <Button variant="outline" size="sm" onClick={handleDelete} className="text-red-500 hover:text-red-600">
          <Trash2 className="h-4 w-4 mr-1" /> Delete
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
          Save
        </Button>
      </div>
    </div>
  );
}