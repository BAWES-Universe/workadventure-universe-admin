'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import AuthLink from '@/app/admin/auth-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AlertCircle, Loader2, Brain, ArrowLeft, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface Memory {
  id: number;
  botId: string;
  playerId: number;
  playerName: string | null;
  memories: any;
  emotions: any;
  lastEmotionUpdate: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// Skeleton loader
function SkeletonRow() {
  return (
    <TableRow>
      <TableCell><div className="h-4 w-24 bg-muted animate-pulse rounded" /></TableCell>
      <TableCell><div className="h-4 w-32 bg-muted animate-pulse rounded" /></TableCell>
      <TableCell><div className="h-4 w-20 bg-muted animate-pulse rounded" /></TableCell>
      <TableCell><div className="h-4 w-40 bg-muted animate-pulse rounded" /></TableCell>
      <TableCell><div className="h-4 w-40 bg-muted animate-pulse rounded" /></TableCell>
      <TableCell><div className="h-4 w-32 bg-muted animate-pulse rounded" /></TableCell>
    </TableRow>
  );
}

export default function MemoryBrowsePage() {
  const router = useRouter();
  const [memory, setMemory] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [filters, setFilters] = useState({
    botId: '',
    playerId: '',
    startDate: '',
    endDate: '',
    page: 1,
    limit: 50,
  });
  const [botIdInput, setBotIdInput] = useState('');
  const [playerIdInput, setPlayerIdInput] = useState('');

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (!loading) {
      const timer = setTimeout(() => {
        fetchMemory();
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
      fetchMemory();
    } catch (err) {
      router.push('/admin/login');
    }
  }

  const fetchMemory = useCallback(async () => {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      const params = new URLSearchParams();
      params.append('page', filters.page.toString());
      params.append('limit', filters.limit.toString());
      if (filters.botId) params.append('botId', filters.botId);
      if (filters.playerId) params.append('playerId', filters.playerId);
      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);

      const response = await authenticatedFetch(`/api/admin/bots/memory?${params.toString()}`);

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          router.push('/admin');
          return;
        }
        throw new Error('Failed to fetch memory');
      }

      const data = await response.json();
      setMemory(data.memory || []);
      setPagination(data.pagination || null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [filters, router]);

  const handlePageChange = (newPage: number) => {
    setFilters({ ...filters, page: newPage });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  function formatDate(date: Date | string): string {
    return new Date(date).toLocaleString();
  }

  function formatNumber(num: number): string {
    return new Intl.NumberFormat().format(num);
  }

  if (loading && memory.length === 0) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-4xl font-bold tracking-tight">Browse Memory</h1>
            <p className="text-muted-foreground text-lg">
              View and filter all bot memory entries
            </p>
          </div>
        </div>
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Bot ID</TableHead>
                  <TableHead>Player</TableHead>
                  <TableHead>Last Updated</TableHead>
                  <TableHead>Memories</TableHead>
                  <TableHead>Emotions</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...Array(10)].map((_, i) => (
                  <SkeletonRow key={i} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" asChild>
            <AuthLink href="/admin/bots/database">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </AuthLink>
          </Button>
          <div className="space-y-1">
            <h1 className="text-4xl font-bold tracking-tight">Browse Memory</h1>
            <p className="text-muted-foreground text-lg">
              View and filter all bot memory entries
            </p>
          </div>
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
              onClick={fetchMemory}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor="botId">Bot ID</Label>
              <div className="flex gap-2">
                <Input
                  id="botId"
                  placeholder="Filter by bot ID..."
                  value={botIdInput}
                  onChange={(e) => setBotIdInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setFilters({ ...filters, botId: botIdInput, page: 1 });
                    }
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setFilters({ ...filters, botId: botIdInput, page: 1 })}
                >
                  <Search className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="playerId">Player ID</Label>
              <div className="flex gap-2">
                <Input
                  id="playerId"
                  type="number"
                  placeholder="Filter by player ID..."
                  value={playerIdInput}
                  onChange={(e) => setPlayerIdInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setFilters({ ...filters, playerId: playerIdInput, page: 1 });
                    }
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setFilters({ ...filters, playerId: playerIdInput, page: 1 })}
                >
                  <Search className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="startDate">Start Date</Label>
              <Input
                id="startDate"
                type="date"
                value={filters.startDate}
                onChange={(e) => setFilters({ ...filters, startDate: e.target.value, page: 1 })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="endDate">End Date</Label>
              <Input
                id="endDate"
                type="date"
                value={filters.endDate}
                onChange={(e) => setFilters({ ...filters, endDate: e.target.value, page: 1 })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Memory Table */}
      <Card>
        <CardHeader>
          <CardTitle>Memory Entries</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {memory.length === 0 ? (
            <div className="py-12 text-center">
              <Brain className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
              <h3 className="text-lg font-semibold mb-2">No memory entries found</h3>
              <p className="text-sm text-muted-foreground">
                {Object.values(filters).some(v => v && v !== '1' && v !== '50')
                  ? 'Try adjusting your filters to see more results.'
                  : 'No memory entries have been recorded yet.'}
              </p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Bot ID</TableHead>
                      <TableHead>Player</TableHead>
                      <TableHead>Last Updated</TableHead>
                      <TableHead>Memories</TableHead>
                      <TableHead>Emotions</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {memory.map((mem) => (
                      <TableRow key={mem.id}>
                        <TableCell>
                          <AuthLink
                            href={`/admin/bots/${mem.botId}`}
                            className="text-primary hover:underline font-mono text-sm"
                          >
                            {mem.botId}
                          </AuthLink>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            <div className="font-mono text-sm">{mem.playerId}</div>
                            {mem.playerName && (
                              <div className="text-xs text-muted-foreground">{mem.playerName}</div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{formatDate(mem.updatedAt)}</TableCell>
                        <TableCell>
                          {mem.memories ? (
                            <details className="cursor-pointer">
                              <summary className="text-sm text-muted-foreground">View</summary>
                              <pre className="mt-2 text-xs bg-muted p-2 rounded overflow-auto max-w-md max-h-64">
                                {JSON.stringify(mem.memories, null, 2)}
                              </pre>
                            </details>
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {mem.emotions ? (
                            <details className="cursor-pointer">
                              <summary className="text-sm text-muted-foreground">View</summary>
                              <pre className="mt-2 text-xs bg-muted p-2 rounded overflow-auto max-w-md max-h-64">
                                {JSON.stringify(mem.emotions, null, 2)}
                              </pre>
                            </details>
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">{formatDate(mem.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {pagination && pagination.totalPages > 1 && (
                <div className="flex items-center justify-between p-4 border-t">
                  <div className="text-sm text-muted-foreground">
                    Showing {((pagination.page - 1) * pagination.limit) + 1} - {Math.min(pagination.page * pagination.limit, pagination.total)} of {formatNumber(pagination.total)} entries
                  </div>
                  <div className="flex items-center gap-2">
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
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
