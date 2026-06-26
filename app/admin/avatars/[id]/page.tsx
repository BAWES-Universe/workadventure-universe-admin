'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import AuthLink from '@/app/admin/auth-link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  Loader2, ArrowLeft, AlertCircle, Layers, Puzzle, Globe, Lock, EyeOff,
  Users, CheckCircle2, Plus, Trash2, Save, Archive, Copy, ExternalLink,
  FileText,
} from 'lucide-react';
import TextureCard from '@/components/texture-card';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Scope {
  id: string; scopeType: string; scopeId: string; worldId?: string | null;
}
interface Policy {
  id: string; subjectType: string; subjectValue: string | null; action: string; worldId: string | null; isActive: boolean;
}
interface Grant {
  id: string; userId: string; grantType: string; note: string | null; expiresAt: string | null; isActive: boolean; grantedAt: string;
  user: { id: string; name: string | null; email: string | null; uuid: string } | null;
}
interface Layer {
  id: string; textureId: string; name: string | null; layer: string; url: string; position: number; isActive: boolean;
}
interface Companion {
  id: string; textureId: string; name: string | null; url: string; behavior: string | null; position: number; isActive: boolean;
}
interface AuditLog {
  id: string; action: string; diff: unknown; createdAt: string;
  actor: { id: string; name: string | null; email: string | null } | null;
}
interface AvatarSet {
  id: string; slug: string; name: string; description: string | null; kind: string;
  lifecycle: string; visibility: string; sourceOwnerType: string; partnerRef: string | null;
  campaignCode: string | null; monetizationType: string; billingReference: string | null;
  licenseNotes: string | null; position: number;
  availableFrom: string | null; availableUntil: string | null;
  createdAt: string; updatedAt: string;
  layers: Layer[]; companions: Companion[]; scopes: Scope[];
  policies: Policy[]; userGrants: Grant[];
  auditLogs?: AuditLog[];
}

const LAYER_TYPES = ['woka', 'body', 'eyes', 'hair', 'clothes', 'hat', 'accessory'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lifecycleBadge(lifecycle: string) {
  const styles: Record<string, string> = {
    active: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    draft: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    archived: 'bg-slate-500/15 text-slate-600 dark:text-slate-400',
  };
  return <Badge variant="outline" className={styles[lifecycle] || ''}>{lifecycle}</Badge>;
}

function visibilityLabel(v: string) {
  const labels: Record<string, string> = {
    public: 'Public', hidden: 'Hidden', restricted: 'Restricted', assigned_only: 'Assigned Only',
  };
  return labels[v] || v;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AvatarSetDetailPage() {
  const router = useRouter();
  const params = useParams();
  const setId = params?.id as string;

  const [checkingAuth, setCheckingAuth] = useState(true);
  const [set, setSet] = useState<AvatarSet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Edit form state
  const [editForm, setEditForm] = useState({
    name: '', slug: '', description: '', kind: '', visibility: '', lifecycle: '',
    position: 0, availableFrom: '', availableUntil: '',
  });

  // New layer/companion form state
  const [newLayer, setNewLayer] = useState({ textureId: '', name: '', layer: 'body', url: '', position: 0 });
  const [newCompanion, setNewCompanion] = useState({ textureId: '', name: '', url: '', behavior: '', position: 0 });
  const [newScope, setNewScope] = useState({ scopeType: 'universe', scopeId: '' });
  const [newPolicy, setNewPolicy] = useState({ subjectType: 'membership_tag', subjectValue: '', action: 'select' });
  const [newGrant, setNewGrant] = useState({ userId: '', grantType: 'select', note: '', expiresAt: '' });
  const [addSubmitting, setAddSubmitting] = useState(false);

  // Access check
  const [accessUserId, setAccessUserId] = useState('');
  const [accessWorldId, setAccessWorldId] = useState('');
  const [accessResult, setAccessResult] = useState<unknown>(null);
  const [accessChecking, setAccessChecking] = useState(false);
  const [accessUsers, setAccessUsers] = useState<Array<{ id: string; name: string | null; email: string | null; uuid: string }>>([]);
  const [accessWorlds, setAccessWorlds] = useState<Array<{ id: string; name: string; slug: string; universe: { name: string } }>>([]);
  const [accessSearchUser, setAccessSearchUser] = useState('');
  const [accessSearchWorld, setAccessSearchWorld] = useState('');
  const [collapsedLayers, setCollapsedLayers] = useState<Record<string, boolean>>({});
  const [collapsedCompanions, setCollapsedCompanions] = useState(true);

  const fetchSet = useCallback(async () => {
    if (!setId) return;
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const res = await authenticatedFetch(`/api/admin/avatar-sets/${setId}`);
      if (res.status === 401) { router.push('/admin/login'); return; }
      if (!res.ok) throw new Error('Not found');
      const data = await res.json();
      setSet(data);
      setEditForm({
        name: data.name,
        slug: data.slug,
        description: data.description || '',
        kind: data.kind,
        visibility: data.visibility,
        lifecycle: data.lifecycle,
        position: data.position,
        availableFrom: data.availableFrom ? data.availableFrom.slice(0, 16) : '',
        availableUntil: data.availableUntil ? data.availableUntil.slice(0, 16) : '',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [setId, router]);

  useEffect(() => {
    async function init() {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      try {
        const res = await authenticatedFetch('/api/auth/me');
        if (!res.ok) { router.push('/admin/login'); return; }
      } catch {
        router.push('/admin/login'); return;
      }
      setCheckingAuth(false);
      fetchSet();
    }
    init();
  }, [fetchSet, router]);

  // Save metadata
  async function handleSave() {
    if (!set) return;
    setSaving(true); setError(null); setSuccessMsg(null);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const body: Record<string, unknown> = {
        name: editForm.name,
        description: editForm.description || null,
        kind: editForm.kind,
        visibility: editForm.visibility,
        lifecycle: editForm.lifecycle,
        position: editForm.position,
      };
      if (editForm.availableFrom) body.availableFrom = editForm.availableFrom;
      if (editForm.availableUntil) body.availableUntil = editForm.availableUntil;
      const res = await authenticatedFetch(`/api/admin/avatar-sets/${set.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      const updated = await res.json();
      setSet(updated);
      setSuccessMsg('Saved');
      setTimeout(() => setSuccessMsg(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  // Archive
  async function handleArchive() {
    if (!set || !confirm('Archive this set? Active grants will block archiving.')) return;
    setSaving(true);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const res = await authenticatedFetch(`/api/admin/avatar-sets/${set.id}`, { method: 'DELETE' });
      if (res.status === 409) {
        const data = await res.json();
        throw new Error(data.error || 'Cannot archive');
      }
      if (!res.ok) throw new Error('Archive failed');
      fetchSet();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Archive failed');
    } finally {
      setSaving(false);
    }
  }

  // Add layer
  async function handleAddLayer() {
    if (!set || !newLayer.textureId || !newLayer.url) return;
    setAddSubmitting(true);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const res = await authenticatedFetch(`/api/admin/avatar-sets/${set.id}/layers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newLayer),
      });
      if (!res.ok) throw new Error('Failed to add layer');
      setNewLayer({ textureId: '', name: '', layer: 'body', url: '', position: 0 });
      fetchSet();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setAddSubmitting(false);
    }
  }

  // Delete layer
  async function handleDeleteLayer(layerId: string) {
    if (!set) return;
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      await authenticatedFetch(`/api/admin/avatar-sets/${set.id}/layers/${layerId}`, { method: 'DELETE' });
      fetchSet();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  // Add companion
  async function handleAddCompanion() {
    if (!set || !newCompanion.textureId || !newCompanion.url) return;
    setAddSubmitting(true);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const res = await authenticatedFetch(`/api/admin/avatar-sets/${set.id}/companions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newCompanion),
      });
      if (!res.ok) throw new Error('Failed to add companion');
      setNewCompanion({ textureId: '', name: '', url: '', behavior: '', position: 0 });
      fetchSet();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setAddSubmitting(false);
    }
  }

  // Delete companion
  async function handleDeleteCompanion(companionId: string) {
    if (!set) return;
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      await authenticatedFetch(`/api/admin/avatar-sets/${set.id}/companions/${companionId}`, { method: 'DELETE' });
      fetchSet();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  // Add scope
  async function handleAddScope() {
    if (!set) return;
    setAddSubmitting(true);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const res = await authenticatedFetch(`/api/admin/avatar-sets/${set.id}/scopes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newScope),
      });
      if (!res.ok) throw new Error('Failed to add scope');
      setNewScope({ scopeType: 'universe', scopeId: '' });
      fetchSet();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setAddSubmitting(false);
    }
  }

  // Delete scope
  async function handleDeleteScope(scopeId: string) {
    if (!set) return;
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      await authenticatedFetch(`/api/admin/avatar-sets/${set.id}/scopes/${scopeId}`, { method: 'DELETE' });
      fetchSet();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  // Add policy
  async function handleAddPolicy() {
    if (!set || !newPolicy.subjectValue) return;
    setAddSubmitting(true);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const res = await authenticatedFetch(`/api/admin/avatar-sets/${set.id}/policies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newPolicy),
      });
      if (!res.ok) throw new Error('Failed to add policy');
      setNewPolicy({ subjectType: 'membership_tag', subjectValue: '', action: 'select' });
      fetchSet();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setAddSubmitting(false);
    }
  }

  // Delete policy
  async function handleDeletePolicy(policyId: string) {
    if (!set) return;
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      await authenticatedFetch(`/api/admin/avatar-sets/${set.id}/policies/${policyId}`, { method: 'DELETE' });
      fetchSet();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  // Add grant
  async function handleAddGrant() {
    if (!set || !newGrant.userId) return;
    setAddSubmitting(true);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const body: Record<string, unknown> = {
        userId: newGrant.userId,
        grantType: newGrant.grantType,
        note: newGrant.note || null,
      };
      if (newGrant.expiresAt) body.expiresAt = newGrant.expiresAt;
      const res = await authenticatedFetch(`/api/admin/avatar-sets/${set.id}/grants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Failed to add grant');
      setNewGrant({ userId: '', grantType: 'select', note: '', expiresAt: '' });
      fetchSet();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setAddSubmitting(false);
    }
  }

  // Revoke grant
  async function handleRevokeGrant(grantId: string) {
    if (!set) return;
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      await authenticatedFetch(`/api/admin/avatar-sets/${set.id}/grants/${grantId}`, { method: 'DELETE' });
      fetchSet();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  // Access check
  async function handleAccessCheck() {
    if (!set || !accessUserId || !accessWorldId) return;
    setAccessChecking(true); setAccessResult(null);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const res = await authenticatedFetch(
        `/api/admin/avatar-sets/${set.id}/access-check?userId=${accessUserId}&worldId=${accessWorldId}`
      );
      if (!res.ok) throw new Error('Access check failed');
      setAccessResult(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Access check failed');
    } finally {
      setAccessChecking(false);
    }
  }

  // Loading / auth states
  if (checkingAuth || loading) {
    return (
      <div className="flex items-center justify-center min-h-[300px]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && !set) {
    return (
      <div className="space-y-4">
        <AuthLink href="/admin/avatars">
          <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-2" />Back</Button>
        </AuthLink>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Not found</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!set) return null;

  // Filter layers by type
  const layersByType: Record<string, Layer[]> = {};
  for (const t of LAYER_TYPES) layersByType[t] = [];
  for (const l of set.layers ?? []) {
    if (!layersByType[l.layer]) layersByType[l.layer] = [];
    layersByType[l.layer].push(l);
  }

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <AuthLink href="/admin/avatars">
            <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
          </AuthLink>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{set.name}</h1>
              {lifecycleBadge(set.lifecycle)}
              <Badge variant="secondary" className="text-xs">{visibilityLabel(set.visibility)}</Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">{set.slug}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {successMsg && <span className="text-xs text-emerald-600">{successMsg}</span>}
          {set.lifecycle !== 'archived' && (
            <Button variant="outline" size="sm" onClick={handleArchive} disabled={saving}>
              <Archive className="h-3.5 w-3.5 mr-1.5" />
              Archive
            </Button>
          )}
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
            Save
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={v => {
        setActiveTab(v);
        if (v === 'access' && accessUsers.length === 0) {
          (async () => {
            const { authenticatedFetch } = await import('@/lib/client-auth');
            try {
              const u = await authenticatedFetch('/api/admin/users?limit=200');
              if (u.ok) setAccessUsers((await u.json()).users || await u.json());
            } catch {}
            try {
              const w = await authenticatedFetch('/api/admin/worlds?limit=200');
              if (w.ok) setAccessWorlds((await w.json()).worlds || await w.json());
            } catch {}
          })();
        }
      }}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="layers">Layers ({set.layers?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="companions">Companions ({set.companions?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="scopes">Scopes ({set.scopes?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="policies">Policies ({set.policies?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="grants">Grants ({set.userGrants?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="access">Access Check</TabsTrigger>
          <TabsTrigger value="audit">
            Audit
            {set.auditLogs && <span className="ml-1">({set.auditLogs.length})</span>}
          </TabsTrigger>
        </TabsList>

        {/* === OVERVIEW === */}
        <TabsContent value="overview" className="space-y-4">
          <Card className="border-border/50">
            <CardHeader><CardTitle className="text-base">Metadata</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Name</Label>
                  <Input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label>Slug</Label>
                  <Input value={editForm.slug} onChange={e => setEditForm(f => ({ ...f, slug: e.target.value }))} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} rows={3} />
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                <div className="space-y-2">
                  <Label>Kind</Label>
                  <Select value={editForm.kind} onValueChange={v => setEditForm(f => ({ ...f, kind: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="woka">Woka</SelectItem>
                      <SelectItem value="companion">Companion</SelectItem>
                      <SelectItem value="mixed">Mixed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Visibility</Label>
                  <Select value={editForm.visibility} onValueChange={v => setEditForm(f => ({ ...f, visibility: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="public">Public</SelectItem>
                      <SelectItem value="restricted">Restricted</SelectItem>
                      <SelectItem value="hidden">Hidden</SelectItem>
                      <SelectItem value="assigned_only">Assigned Only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Lifecycle</Label>
                  <div className="flex items-center h-10 px-3 border rounded-md text-sm bg-muted/30">
                    {lifecycleBadge(editForm.lifecycle)}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Position</Label>
                  <Input type="number" value={editForm.position} onChange={e => setEditForm(f => ({ ...f, position: parseInt(e.target.value) || 0 }))} />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Available From</Label>
                  <Input type="datetime-local" value={editForm.availableFrom} onChange={e => setEditForm(f => ({ ...f, availableFrom: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label>Available Until</Label>
                  <Input type="datetime-local" value={editForm.availableUntil} onChange={e => setEditForm(f => ({ ...f, availableUntil: e.target.value }))} />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/50">
            <CardHeader><CardTitle className="text-base">Commercial</CardTitle></CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-3 text-sm text-muted-foreground">
              <div><span className="font-medium text-foreground">Owner Type:</span> {set.sourceOwnerType}</div>
              <div><span className="font-medium text-foreground">Monetization:</span> {set.monetizationType}</div>
              <div><span className="font-medium text-foreground">Partner Ref:</span> {set.partnerRef || '—'}</div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* === LAYERS === */}
        <TabsContent value="layers" className="space-y-4">
          <Card className="border-border/50">
            <CardHeader>
              <CardTitle className="text-base">Add Texture Layer</CardTitle>
              <CardDescription>Standard WA textures are 96×128 PNG spritesheets</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Short Name</Label>
                  <Input
                    className="h-9 w-28 font-mono text-xs"
                    placeholder="cowboy-hat"
                    value={newLayer.textureId}
                    onChange={e => setNewLayer(f => ({ ...f, textureId: e.target.value.replace(/[/\s]/g, '-').toLowerCase() }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Display Name</Label>
                  <Input className="h-9 w-28" placeholder="Cowboy Hat" value={newLayer.name} onChange={e => setNewLayer(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Layer Type</Label>
                  <Select value={newLayer.layer} onValueChange={v => setNewLayer(f => ({ ...f, layer: v }))}>
                    <SelectTrigger className="h-9 w-24"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LAYER_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 flex-1 min-w-[150px]">
                  <Label className="text-xs">Image URL</Label>
                  <div className="flex gap-1">
                    <Input className="h-9 flex-1 font-mono text-xs" placeholder="http://... or upload" value={newLayer.url} onChange={e => setNewLayer(f => ({ ...f, url: e.target.value }))} />
                    <Button variant="outline" size="sm" className="h-9 shrink-0 text-xs" onClick={() => {
                      const input = document.createElement('input');
                      input.type = 'file';
                      input.accept = 'image/png,image/jpeg,image/webp';
                      input.onchange = async (e) => {
                        const file = (e.target as HTMLInputElement).files?.[0];
                        if (!file) return;
                        // Auto-fill texture ID from filename (strip extension, kebab-case)
                        const name = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
                        setNewLayer(f => ({ ...f, textureId: name }));
                        // Upload and set URL
                        try {
                          const { authenticatedFetch } = await import('@/lib/client-auth');
                          const fd = new FormData();
                          fd.append('file', file);
                          fd.append('setId', setId);
                          fd.append('textureId', name);
                          const res = await authenticatedFetch('/api/admin/avatar-sets/upload-texture', { method: 'POST', body: fd });
                          if (res.ok) {
                            const data = await res.json();
                            setNewLayer(f => ({ ...f, url: data.url }));
                          }
                        } catch {}
                      };
                      input.click();
                    }}>
                      Upload
                    </Button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Pos</Label>
                  <Input className="h-9 w-14 text-center" type="number" min={0} value={newLayer.position} onChange={e => setNewLayer(f => ({ ...f, position: parseInt(e.target.value) || 0 }))} />
                </div>
                <Button size="sm" className="h-9" onClick={handleAddLayer} disabled={addSubmitting || !newLayer.textureId || !newLayer.url}>
                  {addSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
                  Add
                </Button>
              </div>
              {/* Naming hint */}
              {newLayer.textureId && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(newLayer.textureId) && (
                <p className="text-[10px] text-amber-500 mt-2">Kebab-case only: lowercase letters, numbers, and hyphens</p>
              )}
              {newLayer.textureId && newLayer.layer && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  Path: <code className="text-[10px] font-mono bg-muted px-1 rounded">{newLayer.layer}s/{newLayer.textureId}.png</code>
                  — category auto-set from layer type
                </p>
              )}
            </CardContent>
          </Card>

          {LAYER_TYPES.map(type => {
            const items = layersByType[type] || [];
            if (items.length === 0) return null;
            const isCollapsed = collapsedLayers[type] !== false;
            const displayItems = isCollapsed ? items.slice(0, 12) : items;
            const layerRename = async (id: string, name: string) => {
              const { authenticatedFetch } = await import('@/lib/client-auth');
              await authenticatedFetch(`/api/admin/avatar-sets/${set.id}/layers/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
              });
              fetchSet();
            };
            return (
              <Card key={type} className="border-border/50">
                <CardHeader
                  className="py-3 cursor-pointer select-none"
                  onClick={() => setCollapsedLayers(p => ({ ...p, [type]: !isCollapsed }))}
                >
                  <CardTitle className="text-sm capitalize flex items-center gap-2">
                    {type}
                    <span className="text-muted-foreground font-normal">({items.length})</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {isCollapsed ? `▼ show all` : '▲ collapse'}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="py-2">
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                    {displayItems.map(l => (
                      <TextureCard
                        key={l.id}
                        texture={l}
                        onRename={layerRename}
                        onDelete={(id) => handleDeleteLayer(id)}
                        detailBasePath={`/admin/avatars/${set.id}/layers`}
                      />
                    ))}
                  </div>
                  {isCollapsed && items.length > 12 && (
                    <button
                      className="w-full text-xs text-muted-foreground mt-2 hover:text-foreground transition-colors"
                      onClick={() => setCollapsedLayers(p => ({ ...p, [type]: false }))}
                    >
                      + {items.length - 12} more textures
                    </button>
                  )}
                </CardContent>
              </Card>
            );
          })}
          {LAYER_TYPES.every(t => (layersByType[t] || []).length === 0) && (
            <p className="text-sm text-muted-foreground text-center py-8">No texture layers added yet.</p>
          )}
        </TabsContent>

        {/* === COMPANIONS === */}
        <TabsContent value="companions" className="space-y-4">
          <Card className="border-border/50">
            <CardHeader>
              <CardTitle className="text-base">Add Companion</CardTitle>
              <CardDescription>Standard companion textures are 96×128 PNG spritesheets</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Short Name</Label>
                  <Input className="h-9 w-28 font-mono text-xs" placeholder="robot-pet" value={newCompanion.textureId} onChange={e => setNewCompanion(f => ({ ...f, textureId: e.target.value.replace(/[/\s]/g, '-').toLowerCase() }))} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Display Name</Label>
                  <Input className="h-9 w-28" placeholder="Robot Pet" value={newCompanion.name} onChange={e => setNewCompanion(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="space-y-1.5 flex-1 min-w-[150px]">
                  <Label className="text-xs">Image URL</Label>
                  <div className="flex gap-1">
                    <Input className="h-9 flex-1 font-mono text-xs" placeholder="http://... or upload" value={newCompanion.url} onChange={e => setNewCompanion(f => ({ ...f, url: e.target.value }))} />
                    <Button variant="outline" size="sm" className="h-9 shrink-0 text-xs" onClick={() => {
                      const input = document.createElement('input');
                      input.type = 'file';
                      input.accept = 'image/png,image/jpeg,image/webp';
                      input.onchange = async (e) => {
                        const file = (e.target as HTMLInputElement).files?.[0];
                        if (!file) return;
                        const name = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
                        setNewCompanion(f => ({ ...f, textureId: name }));
                        try {
                          const { authenticatedFetch } = await import('@/lib/client-auth');
                          const fd = new FormData();
                          fd.append('file', file);
                          fd.append('setId', setId);
                          fd.append('textureId', name);
                          const res = await authenticatedFetch('/api/admin/avatar-sets/upload-texture', { method: 'POST', body: fd });
                          if (res.ok) {
                            const data = await res.json();
                            setNewCompanion(f => ({ ...f, url: data.url }));
                          }
                        } catch {}
                      };
                      input.click();
                    }}>
                      Upload
                    </Button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Behavior</Label>
                  <Select value={newCompanion.behavior} onValueChange={v => setNewCompanion(f => ({ ...f, behavior: v }))}>
                    <SelectTrigger className="h-9 w-24"><SelectValue placeholder="none" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value=" ">None</SelectItem>
                      <SelectItem value="cat">Cat</SelectItem>
                      <SelectItem value="dog">Dog</SelectItem>
                      <SelectItem value="red_panda">Red Panda</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button size="sm" className="h-9" onClick={handleAddCompanion} disabled={addSubmitting || !newCompanion.textureId || !newCompanion.url}>
                  {addSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
                  Add
                </Button>
              </div>
              {/* Naming hint */}
              {newCompanion.textureId && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(newCompanion.textureId) && (
                <p className="text-[10px] text-amber-500 mt-2">Kebab-case only: lowercase letters, numbers, and hyphens</p>
              )}
              {newCompanion.textureId && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  Path: <code className="text-[10px] font-mono bg-muted px-1 rounded">companions/{newCompanion.textureId}.png</code>
                  — category auto-set to companions
                </p>
              )}
            </CardContent>
          </Card>

          {/* Companions grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {(collapsedCompanions ? (set.companions ?? []).slice(0, 12) : (set.companions ?? [])).map(c => (
              <TextureCard
                key={c.id}
                texture={c}
                onRename={async (id, name) => {
                  const { authenticatedFetch } = await import('@/lib/client-auth');
                  await authenticatedFetch(`/api/admin/avatar-sets/${set.id}/companions/${id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name }),
                  });
                  fetchSet();
                }}
                onDelete={(id) => handleDeleteCompanion(id)}
                detailBasePath={`/admin/avatars/${set.id}/companions`}
              />
            ))}
          </div>
          {collapsedCompanions && (set.companions ?? []).length > 12 && (
            <button
              className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setCollapsedCompanions(false)}
            >
              + {(set.companions ?? []).length - 12} more companions
            </button>
          )}
          {(set.companions ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">No companions added yet.</p>
          )}
        </TabsContent>

        {/* === SCOPES === */}
        <TabsContent value="scopes" className="space-y-4">
          <Card className="border-border/50">
            <CardHeader><CardTitle className="text-base">Add Scope</CardTitle></CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Scope Type</Label>
                  <Select value={newScope.scopeType} onValueChange={v => setNewScope(f => ({ ...f, scopeType: v }))}>
                    <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="platform">Platform (global)</SelectItem>
                      <SelectItem value="universe">Universe</SelectItem>
                      <SelectItem value="world">World</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {newScope.scopeType !== 'platform' && (
                  <div className="space-y-1.5 flex-1 min-w-[200px]">
                    <Label className="text-xs">Scope ID (universe/world ID)</Label>
                    <Input className="h-9" placeholder="UUID..." value={newScope.scopeId} onChange={e => setNewScope(f => ({ ...f, scopeId: e.target.value }))} />
                  </div>
                )}
                <Button size="sm" className="h-9" onClick={handleAddScope} disabled={addSubmitting || (newScope.scopeType !== 'platform' && !newScope.scopeId)}>
                  {addSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
                  Add
                </Button>
              </div>
            </CardContent>
          </Card>

          {(set.scopes ?? []).map(s => (
            <div key={s.id} className="flex items-center gap-3 text-xs py-2 px-3 rounded border border-border/40">
              <Badge variant="secondary" className="text-[10px] uppercase">{s.scopeType}</Badge>
              <span className="font-mono text-muted-foreground">{s.scopeId || '(global)'}</span>
              <Button variant="ghost" size="icon" className="h-6 w-6 ml-auto text-muted-foreground hover:text-red-500" onClick={() => handleDeleteScope(s.id)}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
          {(set.scopes ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">No scopes set. The set won't be visible anywhere.</p>
          )}
        </TabsContent>

        {/* === POLICIES === */}
        <TabsContent value="policies" className="space-y-4">
          <Card className="border-border/50">
            <CardHeader><CardTitle className="text-base">Add Entitlement Policy</CardTitle></CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Subject Type</Label>
                  <Select value={newPolicy.subjectType} onValueChange={v => setNewPolicy(f => ({ ...f, subjectType: v }))}>
                    <SelectTrigger className="h-9 w-36"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="everyone">Everyone</SelectItem>
                      <SelectItem value="membership_tag">Membership Tag</SelectItem>
                      <SelectItem value="user">Specific User</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 flex-1 min-w-[150px]">
                  <Label className="text-xs">Subject Value</Label>
                  <Input className="h-9" placeholder={newPolicy.subjectType === 'everyone' ? '(not needed)' : 'tag name / user ID'} value={newPolicy.subjectValue} onChange={e => setNewPolicy(f => ({ ...f, subjectValue: e.target.value }))} disabled={newPolicy.subjectType === 'everyone'} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Action</Label>
                  <Select value={newPolicy.action} onValueChange={v => setNewPolicy(f => ({ ...f, action: v }))}>
                    <SelectTrigger className="h-9 w-24"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="select">Select</SelectItem>
                      <SelectItem value="assign_to_bot">Assign Bot</SelectItem>
                      <SelectItem value="manage">Manage</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button size="sm" className="h-9" onClick={handleAddPolicy} disabled={addSubmitting || (newPolicy.subjectType !== 'everyone' && !newPolicy.subjectValue)}>
                  {addSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
                  Add
                </Button>
              </div>
            </CardContent>
          </Card>

          {(set.policies ?? []).map(p => (
            <div key={p.id} className="flex items-center gap-3 text-xs py-2 px-3 rounded border border-border/40">
              <Badge variant="secondary" className="text-[10px]">{p.subjectType}</Badge>
              <span className="font-mono">{p.subjectValue || '(everyone)'}</span>
              <Badge variant="outline" className="text-[10px]">{p.action}</Badge>
              {p.worldId && <span className="text-muted-foreground">world: {p.worldId.slice(0, 8)}...</span>}
              <div className="ml-auto flex items-center gap-2">
                {p.isActive ? <CheckCircle2 className="h-3 w-3 text-emerald-500" /> : <span className="text-muted-foreground">inactive</span>}
                <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-red-500" onClick={() => handleDeletePolicy(p.id)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))}
          {(set.policies ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">No policies. Restricted sets won't be accessible.</p>
          )}
        </TabsContent>

        {/* === GRANTS === */}
        <TabsContent value="grants" className="space-y-4">
          <Card className="border-border/50">
            <CardHeader><CardTitle className="text-base">Issue Grant</CardTitle></CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5 flex-1 min-w-[180px]">
                  <Label className="text-xs">User ID *</Label>
                  <Input className="h-9" placeholder="User UUID..." value={newGrant.userId} onChange={e => setNewGrant(f => ({ ...f, userId: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Type</Label>
                  <Select value={newGrant.grantType} onValueChange={v => setNewGrant(f => ({ ...f, grantType: v }))}>
                    <SelectTrigger className="h-9 w-28"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="select">Select</SelectItem>
                      <SelectItem value="direct">Direct</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Expires</Label>
                  <Input className="h-9 w-36" type="datetime-local" value={newGrant.expiresAt} onChange={e => setNewGrant(f => ({ ...f, expiresAt: e.target.value }))} />
                </div>
                <div className="space-y-1.5 flex-1 min-w-[150px]">
                  <Label className="text-xs">Note</Label>
                  <Input className="h-9" placeholder="Contest winner..." value={newGrant.note} onChange={e => setNewGrant(f => ({ ...f, note: e.target.value }))} />
                </div>
                <Button size="sm" className="h-9" onClick={handleAddGrant} disabled={addSubmitting || !newGrant.userId}>
                  {addSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
                  Issue
                </Button>
              </div>
            </CardContent>
          </Card>

          {(set.userGrants ?? []).map(g => (
            <div key={g.id} className="flex items-center gap-3 text-xs py-2 px-3 rounded border border-border/40">
              <span className="font-mono text-muted-foreground w-24 truncate">{g.user?.name || g.userId.slice(0, 8)}</span>
              <Badge variant="secondary" className="text-[10px]">{g.grantType}</Badge>
              {g.note && <span className="text-muted-foreground truncate max-w-[200px]">{g.note}</span>}
              {g.expiresAt && <span className="text-muted-foreground">expires {new Date(g.expiresAt).toLocaleDateString()}</span>}
              <span className="ml-auto text-muted-foreground">{g.isActive ? 'active' : 'revoked'}</span>
              {g.isActive && (
                <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-red-500" onClick={() => handleRevokeGrant(g.id)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </div>
          ))}
          {(set.userGrants ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">No grants issued.</p>
          )}
        </TabsContent>

        {/* === ACCESS CHECK === */}
        <TabsContent value="access" className="space-y-4">
          <Card className="border-border/50">
            <CardHeader><CardTitle className="text-base">Test Access</CardTitle></CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5 flex-1 min-w-[200px]">
                  <Label className="text-xs">User</Label>
                  <div className="space-y-1">
                    <Input
                      className="h-9 text-xs"
                      placeholder="Search name or email..."
                      value={accessSearchUser}
                      onChange={e => setAccessSearchUser(e.target.value)}
                    />
                    <div className="max-h-[180px] overflow-y-auto border rounded-md p-1 space-y-0.5">
                      {accessUsers
                        .filter(u => !accessSearchUser || (u.name || '').toLowerCase().includes(accessSearchUser.toLowerCase()) || (u.email || '').toLowerCase().includes(accessSearchUser.toLowerCase()))
                        .slice(0, 50)
                        .map(u => (
                          <div
                            key={u.id}
                            className={`text-xs px-2 py-1 rounded cursor-pointer hover:bg-accent ${accessUserId === u.id ? 'bg-primary/10 font-medium' : ''}`}
                            onClick={() => setAccessUserId(u.id)}
                          >
                            {u.name || 'No name'} {u.email ? `<${u.email}>` : ''}
                          </div>
                        ))}
                      {accessUsers.length === 0 && <p className="text-[10px] text-muted-foreground p-2">Loading users...</p>}
                    </div>
                  </div>
                </div>
                <div className="space-y-1.5 flex-1 min-w-[200px]">
                  <Label className="text-xs">World</Label>
                  <div className="space-y-1">
                    <Input
                      className="h-9 text-xs"
                      placeholder="Search world name..."
                      value={accessSearchWorld}
                      onChange={e => setAccessSearchWorld(e.target.value)}
                    />
                    <div className="max-h-[180px] overflow-y-auto border rounded-md p-1 space-y-0.5">
                      {accessWorlds
                        .filter(w => !accessSearchWorld || w.name.toLowerCase().includes(accessSearchWorld.toLowerCase()) || (w.universe?.name || '').toLowerCase().includes(accessSearchWorld.toLowerCase()))
                        .slice(0, 50)
                        .map(w => (
                          <div
                            key={w.id}
                            className={`text-xs px-2 py-1 rounded cursor-pointer hover:bg-accent ${accessWorldId === w.id ? 'bg-primary/10 font-medium' : ''}`}
                            onClick={() => setAccessWorldId(w.id)}
                          >
                            {w.universe?.name || '?'}/{w.name} <span className="text-muted-foreground">({w.slug})</span>
                          </div>
                        ))}
                      {accessWorlds.length === 0 && <p className="text-[10px] text-muted-foreground p-2">Loading worlds...</p>}
                    </div>
                  </div>
                </div>
                <Button size="sm" className="h-9" onClick={handleAccessCheck} disabled={accessChecking || !accessUserId || !accessWorldId}>
                  {accessChecking ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                  Check Access
                </Button>
              </div>
            </CardContent>
          </Card>

          {!!accessResult && (
            <Card className="border-border/50">
              <CardContent className="p-4 space-y-2">
                {(accessResult as Record<string, unknown>).checks ? (
                  <>
                    <div className="flex items-center gap-2 mb-3">
                      <strong>Result: </strong>
                      {(accessResult as Record<string, { passed: boolean }>).canSelect
                        ? <Badge className="bg-emerald-500">Can Select</Badge>
                        : <Badge variant="destructive">Cannot Select</Badge>}
                    </div>
                    <pre className="text-xs text-muted-foreground overflow-auto max-h-80">
                      {JSON.stringify(accessResult, null, 2)}
                    </pre>
                  </>
                ) : (
                  <pre className="text-xs text-muted-foreground overflow-auto max-h-80">
                    {JSON.stringify(accessResult, null, 2)}
                  </pre>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* === AUDIT === */}
        <TabsContent value="audit" className="space-y-4">
          {set.auditLogs && set.auditLogs.length > 0 ? (
            set.auditLogs.map(log => (
              <div key={log.id} className="text-xs py-2 px-3 rounded border border-border/40">
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant="secondary" className="text-[10px]">{log.action}</Badge>
                  <span className="text-muted-foreground">
                    by {log.actor?.name || log.actor?.email || 'unknown'}
                  </span>
                  <span className="text-muted-foreground ml-auto">
                    {new Date(log.createdAt).toLocaleString()}
                  </span>
                </div>
                <pre className="text-[10px] text-muted-foreground/60 mt-1 overflow-auto max-h-20">
                  {JSON.stringify(log.diff, null, 2)}
                </pre>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground text-center py-8">No audit log entries.</p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}