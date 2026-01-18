'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import AuthLink from '@/app/admin/auth-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertCircle, Loader2, Bot, CheckCircle2, XCircle, Search, Filter } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface Bot {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  aiProviderRef: string | null;
  createdAt: string;
  room: {
    id: string;
    name: string;
    slug: string;
    world: {
      id: string;
      name: string;
      slug: string;
      universe: {
        id: string;
        name: string;
        slug: string;
      };
    };
  };
  createdBy: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// Skeleton loader component
function SkeletonCard() {
  return (
    <Card className="group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm">
      <CardContent className="relative flex h-full flex-col p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-5 w-3/4 bg-muted animate-pulse rounded" />
            <div className="flex items-center gap-2">
              <div className="h-5 w-16 bg-muted animate-pulse rounded" />
              <div className="h-5 w-20 bg-muted animate-pulse rounded" />
            </div>
          </div>
        </div>
        <div className="mt-auto space-y-2 pt-3">
          <div className="h-4 w-full bg-muted animate-pulse rounded" />
          <div className="h-4 w-2/3 bg-muted animate-pulse rounded" />
        </div>
        <div className="mt-4 flex gap-2">
          <div className="h-8 flex-1 bg-muted animate-pulse rounded" />
          <div className="h-8 w-20 bg-muted animate-pulse rounded" />
        </div>
      </CardContent>
    </Card>
  );
}

export default function BotsPage() {
  const router = useRouter();
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [filters, setFilters] = useState({
    search: '',
    enabled: '',
    page: 1,
    limit: 20,
  });
  const [searchInput, setSearchInput] = useState('');

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (!loading) {
      // Debounce search
      const timer = setTimeout(() => {
        fetchBots();
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [filters]);

  async function checkAuth() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }
      const userData = await response.json();
      if (!userData.user?.isSuperAdmin) {
        router.push('/admin');
        return;
      }
      fetchBots();
    } catch (err) {
      router.push('/admin/login');
    }
  }

  async function fetchBots() {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      const params = new URLSearchParams();
      params.append('page', filters.page.toString());
      params.append('limit', filters.limit.toString());
      if (filters.search) params.append('search', filters.search);
      if (filters.enabled) params.append('enabled', filters.enabled);

      const response = await authenticatedFetch(`/api/admin/bots?${params.toString()}`);

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          router.push('/admin');
          return;
        }
        throw new Error('Failed to fetch bots');
      }

      const data = await response.json();
      setBots(data.bots || []);
      setPagination(data.pagination || null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    setFilters({ ...filters, search: value, page: 1 });
  };

  const handlePageChange = (newPage: number) => {
    setFilters({ ...filters, page: newPage });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (loading && bots.length === 0) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-4xl font-bold tracking-tight">Bots</h1>
            <p className="text-muted-foreground text-lg">
              Browse and manage all bots
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-4xl font-bold tracking-tight">Bots</h1>
          <p className="text-muted-foreground text-lg">
            Browse and manage all bots across all rooms
          </p>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            {error}
            <Button
              variant="outline"
              size="sm"
              className="ml-4"
              onClick={fetchBots}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="search" className="flex items-center gap-2">
                <Search className="h-4 w-4" />
                Search
              </Label>
              <Input
                id="search"
                placeholder="Search by name or description..."
                value={searchInput}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="enabled" className="flex items-center gap-2">
                <Filter className="h-4 w-4" />
                Status
              </Label>
              <Select
                value={filters.enabled || 'all'}
                onValueChange={(value) => setFilters({ ...filters, enabled: value === 'all' ? '' : value, page: 1 })}
              >
                <SelectTrigger id="enabled">
                  <SelectValue placeholder="All bots" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All bots</SelectItem>
                  <SelectItem value="true">Enabled only</SelectItem>
                  <SelectItem value="false">Disabled only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {pagination && (
              <div className="flex items-end">
                <div className="text-sm text-muted-foreground">
                  Showing {((pagination.page - 1) * pagination.limit) + 1} - {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total} bots
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {bots.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Bot className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
            <h3 className="text-lg font-semibold mb-2">No bots found</h3>
            <p className="text-sm text-muted-foreground">
              {filters.search || filters.enabled
                ? 'Try adjusting your filters to see more results.'
                : 'No bots have been created yet.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {bots.map((bot) => (
              <Card
                key={bot.id}
                className="group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all hover:-translate-y-1 hover:shadow-lg"
              >
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-purple-500/10 via-transparent to-pink-500/20 opacity-0 transition-opacity group-hover:opacity-100" />
                <CardContent className="relative flex h-full flex-col p-5">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <h3 className="text-base font-semibold leading-tight">
                        {bot.name}
                      </h3>
                      <div className="flex items-center gap-2 flex-wrap">
                        {bot.enabled ? (
                          <Badge variant="default" className="bg-green-600">
                            <CheckCircle2 className="mr-1 h-3 w-3" />
                            Enabled
                          </Badge>
                        ) : (
                          <Badge variant="secondary">
                            <XCircle className="mr-1 h-3 w-3" />
                            Disabled
                          </Badge>
                        )}
                        {bot.aiProviderRef && (
                          <Badge variant="outline" className="text-xs">
                            {bot.aiProviderRef}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>

                  {bot.description && (
                    <p className="text-sm text-muted-foreground mb-4 line-clamp-2">
                      {bot.description}
                    </p>
                  )}

                  <div className="mt-auto space-y-2 pt-3 text-xs text-muted-foreground">
                    <div>
                      <span className="font-medium">Room:</span>{' '}
                      <AuthLink
                        href={`/admin/rooms/${bot.room.id}`}
                        className="hover:underline text-foreground"
                      >
                        {bot.room.name}
                      </AuthLink>
                    </div>
                    <div>
                      <span className="font-medium">Location:</span>{' '}
                      <AuthLink
                        href={`/admin/universes/${bot.room.world.universe.id}`}
                        className="hover:underline text-foreground"
                      >
                        {bot.room.world.universe.name}
                      </AuthLink>
                      {' / '}
                      <AuthLink
                        href={`/admin/worlds/${bot.room.world.id}`}
                        className="hover:underline text-foreground"
                      >
                        {bot.room.world.name}
                      </AuthLink>
                    </div>
                    {bot.createdBy && (
                      <div>
                        <span className="font-medium">Created by:</span>{' '}
                        {bot.createdBy.name || bot.createdBy.email}
                      </div>
                    )}
                    <div>
                      <span className="font-medium">Created:</span>{' '}
                      {new Date(bot.createdAt).toLocaleDateString()}
                    </div>
                  </div>

                  <div className="mt-4 flex gap-2">
                    <AuthLink
                      href={`/admin/bots/${bot.id}`}
                      className="flex-1"
                    >
                      <Button variant="outline" size="sm" className="w-full">
                        <Bot className="mr-2 h-4 w-4" />
                        View Details
                      </Button>
                    </AuthLink>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Pagination */}
          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(pagination.page - 1)}
                disabled={pagination.page === 1}
              >
                Previous
              </Button>
              <div className="text-sm text-muted-foreground">
                Page {pagination.page} of {pagination.totalPages}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(pagination.page + 1)}
                disabled={pagination.page >= pagination.totalPages}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
