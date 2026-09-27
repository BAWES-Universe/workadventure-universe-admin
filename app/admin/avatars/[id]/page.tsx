'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2, AlertCircle, ChevronRight, Plus, Trash2, Save, Archive, Upload } from 'lucide-react';
import TextureCard from '@/components/texture-card';
import { KindIcon, LoadError, LoadingRows, PageHeader, StatLine, count } from '../../components/ds';
import { KIND_LABELS, LifecyclePill, Pill, VisibilityPill } from '../components/set-pills';
import { PlaceName, PlaceSearch, type PlaceType } from '../components/scope-picker';

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
  // Each list of the access check: not asked yet, on its way, in, or failed (with a retry).
  const [accessLists, setAccessLists] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
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

  // Archive / Delete
  async function handleArchive() {
    if (!set || !confirm('Archive this set? Active grants will block archiving.')) return;
    setSaving(true);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const res = await authenticatedFetch(`/api/admin/avatar-sets/${set.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lifecycle: 'archived' }),
      });
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

  // Permanent delete (archived sets only)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  function openDeleteConfirm() { setDeleteConfirmOpen(true); setDeleteConfirmName(''); }

  async function handlePermanentDelete() {
    if (!set || deleteConfirmName !== set.name) return;
    setDeleting(true);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const res = await authenticatedFetch(`/api/admin/avatar-sets/${set.id}`, { method: 'DELETE' });
      if (res.status === 409) {
        const data = await res.json();
        throw new Error(data.error || 'Cannot delete');
      }
      if (!res.ok) throw new Error('Delete failed');
      router.push('/admin/avatars');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
      setDeleteConfirmOpen(false);
      setDeleteConfirmName('');
    } finally {
      setDeleting(false);
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
  if (checkingAuth || (loading && !set)) {
    return (
      <div className="grid min-w-0 gap-6">
        <PageHeader kind="avatar" title="Avatar set" />
        <LoadingRows label="the avatar set" rows={4} />
      </div>
    );
  }

  if (error && !set) {
    return (
      <div className="grid min-w-0 gap-6">
        <PageHeader kind="avatar" title="Avatar set" />
        <LoadError label="this avatar set" retry={() => { setError(null); fetchSet(); }} />
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

  const loadAccessLists = async () => {
    setAccessLists('loading');
    const { authenticatedFetch } = await import('@/lib/client-auth');
    try {
      const [u, w] = await Promise.all([
        authenticatedFetch('/api/admin/users?limit=200'),
        authenticatedFetch('/api/admin/worlds?limit=200'),
      ]);
      if (!u.ok || !w.ok) throw new Error('Unable to load people or worlds');
      // Each body is read once: the lists come as { users } / { worlds }, or as a bare array.
      const users = await u.json();
      const worlds = await w.json();
      setAccessUsers(Array.isArray(users) ? users : users.users ?? []);
      setAccessWorlds(Array.isArray(worlds) ? worlds : worlds.worlds ?? []);
      setAccessLists('ready');
    } catch {
      setAccessLists('error');
    }
  };

  const setTab = (v: string) => {
    setActiveTab(v);
    if (v === 'access' && (accessLists === 'idle' || accessLists === 'error')) void loadAccessLists();
  };

  const tabTrigger = 'min-h-11 shrink-0 rounded-lg px-3 data-[state=active]:bg-card';
  const panel = 'mt-4 grid min-w-0 gap-4';
  const formCard = 'min-w-0 rounded-2xl border bg-card p-4 sm:p-5';
  const row = 'flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs';
  const removeButton = 'ml-auto h-9 w-9 text-muted-foreground hover:text-destructive';

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        kind="avatar"
        title={set.name}
        context={
          <StatLine
            items={[
              KIND_LABELS[set.kind] || set.kind,
              count(set.layers?.length ?? 0, 'layer'),
              count(set.companions?.length ?? 0, 'companion'),
            ]}
          />
        }
        status={
          <span className="flex flex-wrap items-center gap-1.5">
            <LifecyclePill lifecycle={set.lifecycle} />
            <VisibilityPill visibility={set.visibility} />
          </span>
        }
        actions={
          <>
            <Button className="h-11" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save
            </Button>
            {set.lifecycle === 'archived' ? (
              <Button variant="outline" className="h-11 text-destructive hover:text-destructive" onClick={openDeleteConfirm} disabled={saving || deleting}>
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </Button>
            ) : (
              <Button variant="outline" className="h-11" onClick={handleArchive} disabled={saving}>
                <Archive className="mr-2 h-4 w-4" />
                Archive
              </Button>
            )}
            {successMsg && (
              <span className="self-center text-sm text-muted-foreground" role="status">
                {successMsg}
              </span>
            )}
          </>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Tabs value={activeTab} onValueChange={setTab} className="min-w-0">
        <TabsList className="flex h-auto w-full justify-start gap-1 overflow-x-auto rounded-xl p-1">
          <TabsTrigger value="overview" className={tabTrigger}>Overview</TabsTrigger>
          <TabsTrigger value="layers" className={tabTrigger}>Layers ({set.layers?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="companions" className={tabTrigger}>Companions ({set.companions?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="scopes" className={tabTrigger}>Available in ({set.scopes?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="policies" className={tabTrigger}>Policies ({set.policies?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="grants" className={tabTrigger}>Grants ({set.userGrants?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="access" className={tabTrigger}>Access check</TabsTrigger>
          <TabsTrigger value="audit" className={tabTrigger}>
            Audit
            {set.auditLogs && <span className="ml-1">({set.auditLogs.length})</span>}
          </TabsTrigger>
        </TabsList>

        {/* === OVERVIEW === */}
        <TabsContent value="overview" className={panel}>
          <section aria-labelledby="set-details" className={formCard}>
            <h2 id="set-details" className="orbit-display mb-4 text-base font-semibold">Name and description</h2>
            <div className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="set-name">Name</Label>
                  <Input id="set-name" className="h-11" value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="set-key">Set key</Label>
                  <Input id="set-key" className="h-11 font-mono" value={editForm.slug} readOnly aria-describedby="set-key-hint" />
                  <p id="set-key-hint" className="text-xs text-muted-foreground">Set when the set is created; it can’t be changed here.</p>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="set-description">Description</Label>
                <Textarea id="set-description" value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} rows={3} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-2">
                  <Label htmlFor="set-kind">Kind</Label>
                  <Select value={editForm.kind} onValueChange={v => setEditForm(f => ({ ...f, kind: v }))}>
                    <SelectTrigger id="set-kind" className="h-11"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="woka">Woka</SelectItem>
                      <SelectItem value="companion">Companion</SelectItem>
                      <SelectItem value="mixed">Mixed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="set-visibility">Visibility</Label>
                  <Select value={editForm.visibility} onValueChange={v => setEditForm(f => ({ ...f, visibility: v }))}>
                    <SelectTrigger id="set-visibility" className="h-11"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="public">Public</SelectItem>
                      <SelectItem value="restricted">Restricted</SelectItem>
                      <SelectItem value="hidden">Hidden</SelectItem>
                      <SelectItem value="assigned_only">Assigned only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="set-lifecycle">Lifecycle</Label>
                  <Select value={editForm.lifecycle} onValueChange={v => setEditForm(f => ({ ...f, lifecycle: v }))}>
                    <SelectTrigger id="set-lifecycle" className="h-11"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="archived">Archived</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="set-position">Display order</Label>
                  <Input id="set-position" className="h-11" type="number" value={editForm.position} onChange={e => setEditForm(f => ({ ...f, position: parseInt(e.target.value) || 0 }))} />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="set-from">Available from</Label>
                  <Input id="set-from" className="h-11" type="datetime-local" value={editForm.availableFrom} onChange={e => setEditForm(f => ({ ...f, availableFrom: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="set-until">Available until</Label>
                  <Input id="set-until" className="h-11" type="datetime-local" value={editForm.availableUntil} onChange={e => setEditForm(f => ({ ...f, availableUntil: e.target.value }))} />
                </div>
              </div>
            </div>
          </section>

          <section aria-labelledby="set-commercial" className={formCard}>
            <h2 id="set-commercial" className="orbit-display mb-4 text-base font-semibold">Commercial</h2>
            <dl className="grid min-w-0 gap-4 text-sm sm:grid-cols-3">
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Owner type</dt>
                <dd className="mt-0.5 [overflow-wrap:anywhere]">{set.sourceOwnerType}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Monetization</dt>
                <dd className="mt-0.5 [overflow-wrap:anywhere]">{set.monetizationType}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Partner ref</dt>
                <dd className="mt-0.5 [overflow-wrap:anywhere]">{set.partnerRef || '—'}</dd>
              </div>
            </dl>
          </section>
        </TabsContent>

        {/* === LAYERS === */}
        <TabsContent value="layers" className={panel}>
          <section aria-labelledby="add-layer" className={formCard}>
            <h2 id="add-layer" className="orbit-display text-base font-semibold">Add a texture layer</h2>
            <p className="mb-4 mt-1 text-xs text-muted-foreground">Standard textures are 96×128 PNG spritesheets.</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,1fr))_6rem]">
              <div className="space-y-2">
                <Label htmlFor="layer-texture">Texture key</Label>
                <Input
                  id="layer-texture"
                  className="h-11 font-mono text-xs"
                  placeholder="cowboy-hat"
                  value={newLayer.textureId}
                  onChange={e => setNewLayer(f => ({ ...f, textureId: e.target.value.replace(/[/\s]/g, '-').toLowerCase() }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="layer-name">Display name</Label>
                <Input id="layer-name" className="h-11" placeholder="Cowboy Hat" value={newLayer.name} onChange={e => setNewLayer(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="layer-type">Layer type</Label>
                <Select value={newLayer.layer} onValueChange={v => setNewLayer(f => ({ ...f, layer: v }))}>
                  <SelectTrigger id="layer-type" className="h-11 capitalize"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LAYER_TYPES.map(t => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="layer-position">Position</Label>
                <Input id="layer-position" className="h-11 text-center" type="number" min={0} value={newLayer.position} onChange={e => setNewLayer(f => ({ ...f, position: parseInt(e.target.value) || 0 }))} />
              </div>
              <div className="space-y-2 sm:col-span-2 lg:col-span-4">
                <Label htmlFor="layer-url">Image URL</Label>
                <div className="flex gap-2">
                  <Input id="layer-url" className="h-11 flex-1 font-mono text-xs" placeholder="http://... or upload" value={newLayer.url} onChange={e => setNewLayer(f => ({ ...f, url: e.target.value }))} />
                  <Button variant="outline" className="h-11 shrink-0" onClick={() => {
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
                    <Upload className="mr-2 h-4 w-4" />
                    Upload
                  </Button>
                </div>
              </div>
            </div>
            {/* Naming hint */}
            {newLayer.textureId && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(newLayer.textureId) && (
              <p className="mt-3 text-xs text-destructive">Lowercase letters, numbers and single hyphens only.</p>
            )}
            {newLayer.textureId && newLayer.layer && (
              <p className="mt-2 text-xs text-muted-foreground">
                Saved as <code className="rounded bg-muted px-1 font-mono">{newLayer.layer}s/{newLayer.textureId}.png</code>; its category follows the layer type.
              </p>
            )}
            <div className="mt-4 flex justify-end">
              <Button variant="outline" className="h-11" onClick={handleAddLayer} disabled={addSubmitting || !newLayer.textureId || !newLayer.url}>
                {addSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                Add layer
              </Button>
            </div>
          </section>

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
              <section key={type} aria-labelledby={`layers-${type}`} className="min-w-0">
                <div className="mb-2 flex min-h-11 items-center justify-between gap-3">
                  <h2 id={`layers-${type}`} className="orbit-display flex items-baseline gap-2 text-base font-semibold capitalize">
                    {type}
                    <span className="font-sans text-xs font-semibold text-muted-foreground">{items.length}</span>
                  </h2>
                  {items.length > 12 && (
                    <Button
                      variant="ghost"
                      className="h-11"
                      aria-expanded={!isCollapsed}
                      onClick={() => setCollapsedLayers(p => ({ ...p, [type]: !isCollapsed }))}
                    >
                      {isCollapsed ? `Show all ${items.length}` : 'Show fewer'}
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
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
              </section>
            );
          })}
          {LAYER_TYPES.every(t => (layersByType[t] || []).length === 0) && (
            <p className="text-sm text-muted-foreground">No texture layers yet.</p>
          )}
        </TabsContent>

        {/* === COMPANIONS === */}
        <TabsContent value="companions" className={panel}>
          <section aria-labelledby="add-companion" className={formCard}>
            <h2 id="add-companion" className="orbit-display text-base font-semibold">Add a companion</h2>
            <p className="mb-4 mt-1 text-xs text-muted-foreground">Standard companion textures are 96×128 PNG spritesheets.</p>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="companion-texture">Texture key</Label>
                <Input id="companion-texture" className="h-11 font-mono text-xs" placeholder="robot-pet" value={newCompanion.textureId} onChange={e => setNewCompanion(f => ({ ...f, textureId: e.target.value.replace(/[/\s]/g, '-').toLowerCase() }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="companion-name">Display name</Label>
                <Input id="companion-name" className="h-11" placeholder="Robot Pet" value={newCompanion.name} onChange={e => setNewCompanion(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="companion-behavior">Behavior</Label>
                <Select value={newCompanion.behavior} onValueChange={v => setNewCompanion(f => ({ ...f, behavior: v }))}>
                  <SelectTrigger id="companion-behavior" className="h-11"><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value=" ">None</SelectItem>
                    <SelectItem value="cat">Cat</SelectItem>
                    <SelectItem value="dog">Dog</SelectItem>
                    <SelectItem value="red_panda">Red Panda</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 sm:col-span-3">
                <Label htmlFor="companion-url">Image URL</Label>
                <div className="flex gap-2">
                  <Input id="companion-url" className="h-11 flex-1 font-mono text-xs" placeholder="http://... or upload" value={newCompanion.url} onChange={e => setNewCompanion(f => ({ ...f, url: e.target.value }))} />
                  <Button variant="outline" className="h-11 shrink-0" onClick={() => {
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
                    <Upload className="mr-2 h-4 w-4" />
                    Upload
                  </Button>
                </div>
              </div>
            </div>
            {/* Naming hint */}
            {newCompanion.textureId && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(newCompanion.textureId) && (
              <p className="mt-3 text-xs text-destructive">Lowercase letters, numbers and single hyphens only.</p>
            )}
            {newCompanion.textureId && (
              <p className="mt-2 text-xs text-muted-foreground">
                Saved as <code className="rounded bg-muted px-1 font-mono">companions/{newCompanion.textureId}.png</code>; its category is companions.
              </p>
            )}
            <div className="mt-4 flex justify-end">
              <Button variant="outline" className="h-11" onClick={handleAddCompanion} disabled={addSubmitting || !newCompanion.textureId || !newCompanion.url}>
                {addSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                Add companion
              </Button>
            </div>
          </section>

          {/* Companions grid */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
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
            <Button variant="ghost" className="h-11 justify-self-center" aria-expanded={false} onClick={() => setCollapsedCompanions(false)}>
              Show all {(set.companions ?? []).length} companions
            </Button>
          )}
          {(set.companions ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">No companions yet.</p>
          )}
        </TabsContent>

        {/* === AVAILABLE IN (scopes) === */}
        <TabsContent value="scopes" className={panel}>
          <section aria-labelledby="add-scope" className={formCard}>
            <h2 id="add-scope" className="orbit-display text-base font-semibold">Make it available</h2>
            <p className="mb-4 mt-1 text-xs text-muted-foreground">Everywhere, or in one universe or world.</p>
            <div className="grid gap-4">
              <div className="space-y-2 sm:max-w-xs">
                <Label htmlFor="scope-type">Where</Label>
                <Select value={newScope.scopeType} onValueChange={v => setNewScope({ scopeType: v, scopeId: '' })}>
                  <SelectTrigger id="scope-type" className="h-11"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="platform">Everywhere (platform)</SelectItem>
                    <SelectItem value="universe">A universe</SelectItem>
                    <SelectItem value="world">A world</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {newScope.scopeType !== 'platform' && (
                <>
                  <PlaceSearch
                    type={newScope.scopeType as PlaceType}
                    value={newScope.scopeId}
                    onPick={id => setNewScope(f => ({ ...f, scopeId: id }))}
                  />
                  <details className="group min-w-0">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold [&::-webkit-details-marker]:hidden">
                      <ChevronRight size={16} className="text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
                      Advanced
                    </summary>
                    <div className="mt-2 space-y-2">
                      <Label htmlFor="scope-id">{newScope.scopeType === 'universe' ? 'Universe' : 'World'} ID</Label>
                      <Input id="scope-id" className="h-11 font-mono text-xs" placeholder="UUID..." value={newScope.scopeId} onChange={e => setNewScope(f => ({ ...f, scopeId: e.target.value }))} />
                      <p className="text-xs text-muted-foreground">For a private one the search can’t find.</p>
                    </div>
                  </details>
                </>
              )}
            </div>
            <div className="mt-4 flex justify-end">
              <Button variant="outline" className="h-11" onClick={handleAddScope} disabled={addSubmitting || (newScope.scopeType !== 'platform' && !newScope.scopeId)}>
                {addSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                Add
              </Button>
            </div>
          </section>

          {(set.scopes ?? []).length > 0 && (
            <div className="grid min-w-0 gap-2">
              {(set.scopes ?? []).map(s => (
                <div key={s.id} className={row}>
                  {s.scopeType === 'universe' || s.scopeType === 'world' ? (
                    <KindIcon kind={s.scopeType} size="sm" />
                  ) : (
                    <Pill>Everywhere</Pill>
                  )}
                  {s.scopeId && (
                    <span className="grid min-w-0">
                      <span className="text-sm font-medium [overflow-wrap:anywhere]"><PlaceName type={s.scopeType} id={s.scopeId} /></span>
                      <span className="font-mono text-[10px] text-muted-foreground [overflow-wrap:anywhere]">{s.scopeId}</span>
                    </span>
                  )}
                  <Button variant="ghost" size="icon" className={removeButton} onClick={() => handleDeleteScope(s.id)} aria-label="Remove">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          {(set.scopes ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">Not available anywhere yet. Add a place so players can see this set.</p>
          )}
        </TabsContent>

        {/* === POLICIES === */}
        <TabsContent value="policies" className={panel}>
          <section aria-labelledby="add-policy" className={formCard}>
            <h2 id="add-policy" className="orbit-display mb-4 text-base font-semibold">Add an entitlement policy</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="policy-subject-type">Who</Label>
                <Select value={newPolicy.subjectType} onValueChange={v => setNewPolicy(f => ({ ...f, subjectType: v }))}>
                  <SelectTrigger id="policy-subject-type" className="h-11"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="everyone">Everyone</SelectItem>
                    <SelectItem value="membership_tag">Membership tag</SelectItem>
                    <SelectItem value="user">Specific user</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="policy-subject-value">Tag or user ID</Label>
                <Input id="policy-subject-value" className="h-11" placeholder={newPolicy.subjectType === 'everyone' ? '(not needed)' : 'tag name / user ID'} value={newPolicy.subjectValue} onChange={e => setNewPolicy(f => ({ ...f, subjectValue: e.target.value }))} disabled={newPolicy.subjectType === 'everyone'} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="policy-action">Can</Label>
                <Select value={newPolicy.action} onValueChange={v => setNewPolicy(f => ({ ...f, action: v }))}>
                  <SelectTrigger id="policy-action" className="h-11"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="select">Select</SelectItem>
                    <SelectItem value="assign_to_bot">Assign to bot</SelectItem>
                    <SelectItem value="manage">Manage</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <Button variant="outline" className="h-11" onClick={handleAddPolicy} disabled={addSubmitting || (newPolicy.subjectType !== 'everyone' && !newPolicy.subjectValue)}>
                {addSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                Add policy
              </Button>
            </div>
          </section>

          {(set.policies ?? []).length > 0 && (
            <div className="grid min-w-0 gap-2">
              {(set.policies ?? []).map(p => (
                <div key={p.id} className={row}>
                  <Pill>{p.subjectType}</Pill>
                  <span className="font-mono [overflow-wrap:anywhere]">{p.subjectValue || '(everyone)'}</span>
                  <Pill>{p.action}</Pill>
                  {p.worldId && <span className="text-muted-foreground">world: {p.worldId.slice(0, 8)}...</span>}
                  <span className="ml-auto text-muted-foreground">{p.isActive ? 'active' : 'inactive'}</span>
                  <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-destructive" onClick={() => handleDeletePolicy(p.id)} aria-label="Remove policy">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          {(set.policies ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">No policies. A restricted set can’t be used until it has one.</p>
          )}
        </TabsContent>

        {/* === GRANTS === */}
        <TabsContent value="grants" className={panel}>
          <section aria-labelledby="add-grant" className={formCard}>
            <h2 id="add-grant" className="orbit-display mb-4 text-base font-semibold">Issue a grant</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="grant-user">User ID *</Label>
                <Input id="grant-user" className="h-11 font-mono text-xs" placeholder="User UUID..." value={newGrant.userId} onChange={e => setNewGrant(f => ({ ...f, userId: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="grant-type">Type</Label>
                <Select value={newGrant.grantType} onValueChange={v => setNewGrant(f => ({ ...f, grantType: v }))}>
                  <SelectTrigger id="grant-type" className="h-11"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="select">Select</SelectItem>
                    <SelectItem value="direct">Direct</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="grant-expires">Expires</Label>
                <Input id="grant-expires" className="h-11" type="datetime-local" value={newGrant.expiresAt} onChange={e => setNewGrant(f => ({ ...f, expiresAt: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="grant-note">Note</Label>
                <Input id="grant-note" className="h-11" placeholder="Contest winner..." value={newGrant.note} onChange={e => setNewGrant(f => ({ ...f, note: e.target.value }))} />
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <Button variant="outline" className="h-11" onClick={handleAddGrant} disabled={addSubmitting || !newGrant.userId}>
                {addSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                Issue grant
              </Button>
            </div>
          </section>

          {(set.userGrants ?? []).length > 0 && (
            <div className="grid min-w-0 gap-2">
              {(set.userGrants ?? []).map(g => (
                <div key={g.id} className={row}>
                  <span className="max-w-[10rem] truncate text-sm font-medium">{g.user?.name || g.userId.slice(0, 8)}</span>
                  <Pill>{g.grantType}</Pill>
                  {g.note && <span className="max-w-[200px] truncate text-muted-foreground">{g.note}</span>}
                  {g.expiresAt && <span className="text-muted-foreground">expires {new Date(g.expiresAt).toLocaleDateString()}</span>}
                  <span className="ml-auto text-muted-foreground">{g.isActive ? 'active' : 'revoked'}</span>
                  {g.isActive && (
                    <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-destructive" onClick={() => handleRevokeGrant(g.id)} aria-label="Revoke grant">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          {(set.userGrants ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">No grants issued.</p>
          )}
        </TabsContent>

        {/* === ACCESS CHECK === */}
        <TabsContent value="access" className={panel}>
          <section aria-labelledby="access-check" className={formCard}>
            <h2 id="access-check" className="orbit-display mb-4 text-base font-semibold">Can this person use the set here?</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="min-w-0 space-y-2">
                <Label htmlFor="access-user-search">Person</Label>
                <Input
                  id="access-user-search"
                  className="h-11"
                  placeholder="Search name or email..."
                  value={accessSearchUser}
                  onChange={e => setAccessSearchUser(e.target.value)}
                />
                <div className="grid max-h-[220px] gap-1 overflow-y-auto rounded-xl border p-1">
                  {accessUsers
                    .filter(u => !accessSearchUser || (u.name || '').toLowerCase().includes(accessSearchUser.toLowerCase()) || (u.email || '').toLowerCase().includes(accessSearchUser.toLowerCase()))
                    .slice(0, 50)
                    .map(u => (
                      <button
                        type="button"
                        key={u.id}
                        aria-pressed={accessUserId === u.id}
                        className="min-h-11 rounded-lg px-3 py-2 text-left text-sm [overflow-wrap:anywhere] hover:bg-muted aria-pressed:bg-accent/60 aria-pressed:font-medium"
                        onClick={() => setAccessUserId(u.id)}
                      >
                        {u.name || 'No name'} {u.email ? <span className="text-muted-foreground">{`<${u.email}>`}</span> : ''}
                      </button>
                    ))}
                  {accessLists === 'loading' && <p className="p-2 text-xs text-muted-foreground">Loading people…</p>}
                  {accessLists === 'ready' && accessUsers.length === 0 && <p className="p-2 text-xs text-muted-foreground">No people yet.</p>}
                </div>
              </div>
              <div className="min-w-0 space-y-2">
                <Label htmlFor="access-world-search">World</Label>
                <Input
                  id="access-world-search"
                  className="h-11"
                  placeholder="Search world name..."
                  value={accessSearchWorld}
                  onChange={e => setAccessSearchWorld(e.target.value)}
                />
                <div className="grid max-h-[220px] gap-1 overflow-y-auto rounded-xl border p-1">
                  {accessWorlds
                    .filter(w => !accessSearchWorld || w.name.toLowerCase().includes(accessSearchWorld.toLowerCase()) || (w.universe?.name || '').toLowerCase().includes(accessSearchWorld.toLowerCase()))
                    .slice(0, 50)
                    .map(w => (
                      <button
                        type="button"
                        key={w.id}
                        aria-pressed={accessWorldId === w.id}
                        className="min-h-11 rounded-lg px-3 py-2 text-left text-sm [overflow-wrap:anywhere] hover:bg-muted aria-pressed:bg-accent/60 aria-pressed:font-medium"
                        onClick={() => setAccessWorldId(w.id)}
                      >
                        {w.universe?.name || '?'} › {w.name} <span className="text-muted-foreground">({w.slug})</span>
                      </button>
                    ))}
                  {accessLists === 'loading' && <p className="p-2 text-xs text-muted-foreground">Loading worlds…</p>}
                  {accessLists === 'ready' && accessWorlds.length === 0 && <p className="p-2 text-xs text-muted-foreground">No worlds yet.</p>}
                </div>
              </div>
            </div>
            {accessLists === 'error' && (
              <div className="mt-3">
                <LoadError label="people and worlds" retry={() => void loadAccessLists()} />
              </div>
            )}
            <div className="mt-4 flex justify-end">
              <Button className="h-11" variant="outline" onClick={handleAccessCheck} disabled={accessChecking || !accessUserId || !accessWorldId}>
                {accessChecking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Check access
              </Button>
            </div>
          </section>

          {!!accessResult && (
            <section aria-label="Access check result" className={formCard}>
              {(accessResult as Record<string, unknown>).checks ? (
                <div className="mb-3 flex items-center gap-2 text-sm">
                  <strong>Result:</strong>
                  {(accessResult as Record<string, { passed: boolean }>).canSelect ? (
                    <Pill><i aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-green-500" />Can select</Pill>
                  ) : (
                    <Pill><i aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-destructive" />Cannot select</Pill>
                  )}
                </div>
              ) : null}
              <pre className="max-h-80 overflow-auto text-xs text-muted-foreground">
                {JSON.stringify(accessResult, null, 2)}
              </pre>
            </section>
          )}
        </TabsContent>

        {/* === AUDIT === */}
        <TabsContent value="audit" className={panel}>
          {set.auditLogs && set.auditLogs.length > 0 ? (
            <div className="grid min-w-0 gap-2">
              {set.auditLogs.map(log => (
                <div key={log.id} className="min-w-0 rounded-xl border border-border bg-card px-3 py-2 text-xs">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Pill>{log.action}</Pill>
                    <span className="text-muted-foreground">
                      by {log.actor?.name || log.actor?.email || 'unknown'}
                    </span>
                    <span className="ml-auto text-muted-foreground">
                      {new Date(log.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <pre className="mt-1 max-h-20 overflow-auto text-[10px] text-muted-foreground">
                    {JSON.stringify(log.diff, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No audit log entries.</p>
          )}
        </TabsContent>
      </Tabs>

      {/* Delete confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={open => { if (!deleting) setDeleteConfirmOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete &ldquo;{set.name}&rdquo;?</DialogTitle>
            <DialogDescription>
              This permanently removes this avatar set, all its layers, companions, places, grants and policies.
              Uploaded textures on S3 are deleted too. <strong>This can’t be undone.</strong>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="delete-confirm-name">Type the set name to confirm</Label>
            <Input
              id="delete-confirm-name"
              className="h-11"
              placeholder={set.name}
              value={deleteConfirmName}
              onChange={e => setDeleteConfirmName(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="h-11" onClick={() => setDeleteConfirmOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="h-11"
              onClick={handlePermanentDelete}
              disabled={deleteConfirmName !== set.name || deleting}
            >
              {deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
