'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import AuthLink from '@/app/admin/auth-link';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus } from 'lucide-react';
import { EmptyCard, EntityRow, Figure, Figures, LoadError, LoadingRows, PageHeader, StatLine, count } from '../components/ds';
import { SearchBox } from '../discover/discover-ui';
import { KIND_LABELS, LifecyclePill, VisibilityPill } from './components/set-pills';

interface AvatarSet {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: string;
  lifecycle: string;
  visibility: string;
  position: number;
  sourceOwnerType: string;
  partnerRef: string | null;
  availableFrom: string | null;
  availableUntil: string | null;
  createdAt: string;
  updatedAt: string;
  _count: {
    layers: number;
    companions: number;
    policies: number;
    userGrants: number;
  };
  scopes: Array<{ id: string; scopeType: string; scopeId: string }>;
}

export default function AvatarSetsPage() {
  const router = useRouter();
  const [sets, setSets] = useState<AvatarSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [lifecycleFilter, setLifecycleFilter] = useState('all');
  const [visibilityFilter, setVisibilityFilter] = useState('all');
  const [checkingAuth, setCheckingAuth] = useState(true);

  const fetchSets = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const params = new URLSearchParams();
      if (lifecycleFilter !== 'all') params.set('lifecycle', lifecycleFilter);
      if (visibilityFilter !== 'all') params.set('visibility', visibilityFilter);
      const res = await authenticatedFetch(`/api/admin/avatar-sets?${params}`);
      if (res.status === 401) {
        router.push('/admin/login');
        return;
      }
      if (!res.ok) throw new Error('Failed to load avatar sets');
      const data = await res.json();
      setSets(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [lifecycleFilter, visibilityFilter, router]);

  useEffect(() => {
    async function init() {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      try {
        const res = await authenticatedFetch('/api/auth/me');
        if (!res.ok) { router.push('/admin/login'); return; }
      } catch {
        router.push('/admin/login');
        return;
      }
      setCheckingAuth(false);
      fetchSets();
    }
    init();
  }, [fetchSets, router]);

  const filtered = sets.filter(s =>
    !search || s.name.toLowerCase().includes(search.toLowerCase()) || s.slug.toLowerCase().includes(search.toLowerCase())
  );
  const filtering = lifecycleFilter !== 'all' || visibilityFilter !== 'all' || search !== '';

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        kind="avatar"
        title="Avatar sets"
        context={<span className="text-sm text-muted-foreground">Wokas and companions</span>}
        stats={
          !checkingAuth && !loading && !error && sets.length > 0 && (
            <Figures>
              <Figure value={sets.filter(s => s.lifecycle === 'active').length} label="active" />
              <Figure value={sets.filter(s => s.lifecycle === 'draft').length} label="drafts" />
              <Figure value={sets.filter(s => s.visibility === 'restricted').length} label="restricted" />
              <Figure value={sets.reduce((a, s) => a + s._count.layers, 0)} label="layers" />
            </Figures>
          )
        }
        actions={
          <Button asChild className="h-11">
            <AuthLink href="/admin/avatars/new">
              <Plus className="mr-2 h-4 w-4" />
              New set
            </AuthLink>
          </Button>
        }
      />

      <div className="grid min-w-0 gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-center">
        <SearchBox
          value={search}
          onChange={setSearch}
          onSubmit={() => {}}
          onClear={() => setSearch('')}
          label="Search avatar sets"
          placeholder="Search by name or key"
        />
        <Select value={lifecycleFilter} onValueChange={setLifecycleFilter}>
          <SelectTrigger className="h-11 sm:w-[150px]" aria-label="Lifecycle">
            <SelectValue placeholder="Lifecycle" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any lifecycle</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
        <Select value={visibilityFilter} onValueChange={setVisibilityFilter}>
          <SelectTrigger className="h-11 sm:w-[150px]" aria-label="Visibility">
            <SelectValue placeholder="Visibility" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any visibility</SelectItem>
            <SelectItem value="public">Public</SelectItem>
            <SelectItem value="restricted">Restricted</SelectItem>
            <SelectItem value="hidden">Hidden</SelectItem>
            <SelectItem value="assigned_only">Assigned only</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error && <LoadError label="avatar sets" retry={fetchSets} />}

      {checkingAuth || (loading && sets.length === 0) ? (
        <LoadingRows label="avatar sets" rows={4} />
      ) : filtered.length === 0 ? (
        !error &&
        (filtering ? (
          <p className="text-sm text-muted-foreground" role="status">
            No sets match these filters.
          </p>
        ) : (
          <EmptyCard
            kind="avatar"
            title="No avatar sets yet."
            text="A set decides which wokas and companions players can pick."
            href="/admin/avatars/new"
            action="Create a set"
          />
        ))
      ) : (
        <div className="grid min-w-0 gap-0.5">
          {filtered.map(set => (
            <EntityRow
              key={set.id}
              href={`/admin/avatars/${set.id}`}
              kind="avatar"
              title={set.name}
              context={
                <StatLine
                  items={[
                    KIND_LABELS[set.kind] || set.kind,
                    count(set._count.layers, 'layer'),
                    count(set._count.companions, 'companion'),
                  ]}
                />
              }
              meta={
                <>
                  {set.description && <span className="line-clamp-2 text-xs text-muted-foreground">{set.description}</span>}
                  <span className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <LifecyclePill lifecycle={set.lifecycle} />
                    <VisibilityPill visibility={set.visibility} />
                    <span className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{set.slug}</span>
                  </span>
                </>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
