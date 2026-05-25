'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import AuthLink from '@/app/admin/auth-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertCircle, Loader2, Plus, Search, Eye, EyeOff, Globe, Lock,
  Layers, Puzzle, Archive, Draft, CheckCircle2, Users,
} from 'lucide-react';

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
  scopes: Array<{ id: string; scopeType: string; scopeId: string | null }>;
}

const VISIBILITY_LABELS: Record<string, string> = {
  public: 'Public',
  hidden: 'Hidden',
  restricted: 'Restricted',
  assigned_only: 'Assigned Only',
};

const LIFECYCLE_LABELS: Record<string, string> = {
  draft: 'Draft',
  active: 'Active',
  archived: 'Archived',
};

const KIND_LABELS: Record<string, string> = {
  woka: 'Woka',
  companion: 'Companion',
  mixed: 'Mixed',
};

function lifecycleColor(lifecycle: string): string {
  switch (lifecycle) {
    case 'active': return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800';
    case 'draft': return 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800';
    case 'archived': return 'bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700';
    default: return '';
  }
}

function visibilityIcon(visibility: string) {
  switch (visibility) {
    case 'public': return <Globe className="h-3.5 w-3.5" />;
    case 'restricted': return <Lock className="h-3.5 w-3.5" />;
    case 'hidden': return <EyeOff className="h-3.5 w-3.5" />;
    case 'assigned_only': return <Users className="h-3.5 w-3.5" />;
    default: return <Eye className="h-3.5 w-3.5" />;
  }
}

function SkeletonCard() {
  return (
    <Card className="animate-pulse border-border/50">
      <CardContent className="p-5">
        <div className="h-5 w-2/3 bg-muted rounded mb-3" />
        <div className="h-4 w-full bg-muted rounded mb-2" />
        <div className="h-4 w-1/2 bg-muted rounded mb-4" />
        <div className="flex gap-2">
          <div className="h-5 w-16 bg-muted rounded" />
          <div className="h-5 w-16 bg-muted rounded" />
        </div>
      </CardContent>
    </Card>
  );
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

  if (checkingAuth) {
    return (
      <div className="flex items-center justify-center min-h-[300px]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const filtered = sets.filter(s =>
    !search || s.name.toLowerCase().includes(search.toLowerCase()) || s.slug.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Avatar Sets</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage woka and companion texture collections with scoped access control
          </p>
        </div>
        <AuthLink href="/admin/avatars/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            New Set
          </Button>
        </AuthLink>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="border-border/50">
          <CardContent className="p-4 flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
            <div>
              <div className="text-2xl font-bold">{sets.filter(s => s.lifecycle === 'active').length}</div>
              <div className="text-xs text-muted-foreground">Active</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border/50">
          <CardContent className="p-4 flex items-center gap-3">
            <Draft className="h-5 w-5 text-amber-500" />
            <div>
              <div className="text-2xl font-bold">{sets.filter(s => s.lifecycle === 'draft').length}</div>
              <div className="text-xs text-muted-foreground">Drafts</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border/50">
          <CardContent className="p-4 flex items-center gap-3">
            <Lock className="h-5 w-5 text-violet-500" />
            <div>
              <div className="text-2xl font-bold">{sets.filter(s => s.visibility === 'restricted').length}</div>
              <div className="text-xs text-muted-foreground">Restricted</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border/50">
          <CardContent className="p-4 flex items-center gap-3">
            <Layers className="h-5 w-5 text-blue-500" />
            <div>
              <div className="text-2xl font-bold">{sets.reduce((a, s) => a + s._count.layers, 0)}</div>
              <div className="text-xs text-muted-foreground">Total Layers</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search sets..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={lifecycleFilter} onValueChange={setLifecycleFilter}>
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="Lifecycle" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Lifecycles</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
        <Select value={visibilityFilter} onValueChange={setVisibilityFilter}>
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="Visibility" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Visibility</SelectItem>
            <SelectItem value="public">Public</SelectItem>
            <SelectItem value="restricted">Restricted</SelectItem>
            <SelectItem value="hidden">Hidden</SelectItem>
            <SelectItem value="assigned_only">Assigned Only</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Error */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Sets grid */}
      {loading ? (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="border-dashed border-2">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Layers className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-medium mb-1">No avatar sets yet</h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-sm">
              Create your first avatar set to define which wokas, companions, and textures are available to players.
            </p>
            <AuthLink href="/admin/avatars/new">
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Create Set
              </Button>
            </AuthLink>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map(set => (
            <AuthLink key={set.id} href={`/admin/avatars/${set.id}`}>
              <Card className="cursor-pointer transition-all hover:border-primary/30 hover:shadow-sm border-border/50 h-full">
                <CardContent className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="font-semibold truncate">{set.name}</h3>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {set.slug}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 ml-2 shrink-0">
                      {visibilityIcon(set.visibility)}
                      <Badge variant="outline" className={lifecycleColor(set.lifecycle) + ' text-[10px] px-1.5 py-0'}>
                        {LIFECYCLE_LABELS[set.lifecycle] || set.lifecycle}
                      </Badge>
                    </div>
                  </div>

                  {set.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2 mb-3">
                      {set.description}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="secondary" className="text-[10px] px-1.5">
                      <Layers className="h-3 w-3 mr-1" />
                      {set._count.layers} layers
                    </Badge>
                    <Badge variant="secondary" className="text-[10px] px-1.5">
                      <Puzzle className="h-3 w-3 mr-1" />
                      {set._count.companions} companions
                    </Badge>
                    <Badge variant="secondary" className="text-[10px] px-1.5">
                      {KIND_LABELS[set.kind] || set.kind}
                    </Badge>
                    <span className="text-muted-foreground/50">·</span>
                    <span className="capitalize">{set.visibility.replace('_', ' ')}</span>
                  </div>
                </CardContent>
              </Card>
            </AuthLink>
          ))}
        </div>
      )}
    </div>
  );
}