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
import { AlertCircle, Loader2, MessageSquare, ArrowLeft, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface Conversation {
  id: number;
  botId: string;
  userUuid: string | null;
  userId: string | null;
  userName: string | null;
  isGuest: boolean;
  user?: {
    id: string;
    email: string | null;
    name: string | null;
    uuid: string;
  } | null;
  messages: any;
  messageCount: number;
  startedAt: Date;
  endedAt: Date;
  createdAt: Date;
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
      <TableCell><div className="h-4 w-16 bg-muted animate-pulse rounded" /></TableCell>
      <TableCell><div className="h-4 w-40 bg-muted animate-pulse rounded" /></TableCell>
      <TableCell><div className="h-4 w-40 bg-muted animate-pulse rounded" /></TableCell>
      <TableCell><div className="h-4 w-32 bg-muted animate-pulse rounded" /></TableCell>
    </TableRow>
  );
}

export default function ConversationsBrowsePage() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [filters, setFilters] = useState({
    botId: '',
    userUuid: '',
    userId: '',
    startDate: '',
    endDate: '',
    page: 1,
    limit: 50,
  });
  const [botIdInput, setBotIdInput] = useState('');
  const [userUuidInput, setUserUuidInput] = useState('');
  const [userIdInput, setUserIdInput] = useState('');

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (!loading) {
      const timer = setTimeout(() => {
        fetchConversations();
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
      fetchConversations();
    } catch (err) {
      router.push('/admin/login');
    }
  }

  const fetchConversations = useCallback(async () => {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      const params = new URLSearchParams();
      params.append('page', filters.page.toString());
      params.append('limit', filters.limit.toString());
      if (filters.botId) params.append('botId', filters.botId);
      if (filters.userUuid) params.append('userUuid', filters.userUuid);
      if (filters.userId) params.append('userId', filters.userId);
      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);

      const response = await authenticatedFetch(`/api/admin/bots/conversations?${params.toString()}`);

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          router.push('/admin');
          return;
        }
        throw new Error('Failed to fetch conversations');
      }

      const data = await response.json();
      setConversations(data.conversations || []);
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

  function formatDuration(startedAt: Date | string, endedAt: Date | string): string {
    const start = new Date(startedAt).getTime();
    const end = new Date(endedAt).getTime();
    const seconds = Math.floor((end - start) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  if (loading && conversations.length === 0) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-4xl font-bold tracking-tight">Browse Conversations</h1>
            <p className="text-muted-foreground text-lg">
              View and filter all bot conversations
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
                  <TableHead>Messages</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Ended</TableHead>
                  <TableHead>Messages</TableHead>
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
            <h1 className="text-4xl font-bold tracking-tight">Browse Conversations</h1>
            <p className="text-muted-foreground text-lg">
              View and filter all bot conversations
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
              onClick={fetchConversations}
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
              <Label htmlFor="userUuid">User UUID</Label>
              <div className="flex gap-2">
                <Input
                  id="userUuid"
                  placeholder="Filter by user UUID..."
                  value={userUuidInput}
                  onChange={(e) => setUserUuidInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setFilters({ ...filters, userUuid: userUuidInput, page: 1 });
                    }
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setFilters({ ...filters, userUuid: userUuidInput, page: 1 })}
                >
                  <Search className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="userId">User ID</Label>
              <div className="flex gap-2">
                <Input
                  id="userId"
                  placeholder="Filter by user ID..."
                  value={userIdInput}
                  onChange={(e) => setUserIdInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setFilters({ ...filters, userId: userIdInput, page: 1 });
                    }
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setFilters({ ...filters, userId: userIdInput, page: 1 })}
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

      {/* Conversations Table */}
      <Card>
        <CardHeader>
          <CardTitle>Conversations</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {conversations.length === 0 ? (
            <div className="py-12 text-center">
              <MessageSquare className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
              <h3 className="text-lg font-semibold mb-2">No conversations found</h3>
              <p className="text-sm text-muted-foreground">
                {Object.values(filters).some(v => v && v !== '1' && v !== '50')
                  ? 'Try adjusting your filters to see more results.'
                  : 'No conversations have been recorded yet.'}
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
                      <TableHead>Messages</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead>Started</TableHead>
                      <TableHead>Ended</TableHead>
                      <TableHead>Messages</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {conversations.map((conv) => (
                      <TableRow key={conv.id}>
                        <TableCell>
                          <AuthLink
                            href={`/admin/bots/${conv.botId}`}
                            className="text-primary hover:underline font-mono text-sm"
                          >
                            {conv.botId}
                          </AuthLink>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            {conv.user ? (
                              <>
                                <div className="font-semibold">{conv.user.name || conv.userName || 'Unknown'}</div>
                                {conv.user.email && (
                                  <div className="text-xs text-muted-foreground">{conv.user.email}</div>
                                )}
                                <div className="text-xs font-mono text-muted-foreground">
                                  {conv.userId || conv.userUuid || 'N/A'}
                                </div>
                                {conv.isGuest && (
                                  <Badge variant="outline" className="text-xs">Guest</Badge>
                                )}
                              </>
                            ) : (
                              <>
                                <div className="font-semibold">{conv.userName || 'Unknown'}</div>
                                <div className="text-xs font-mono text-muted-foreground">
                                  {conv.userUuid || 'N/A'}
                                </div>
                                {conv.isGuest && (
                                  <Badge variant="outline" className="text-xs">Guest</Badge>
                                )}
                              </>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{conv.messageCount}</Badge>
                        </TableCell>
                        <TableCell className="text-sm">
                          {formatDuration(conv.startedAt, conv.endedAt)}
                        </TableCell>
                        <TableCell className="text-sm">{formatDate(conv.startedAt)}</TableCell>
                        <TableCell className="text-sm">{formatDate(conv.endedAt)}</TableCell>
                        <TableCell>
                          <details className="cursor-pointer">
                            <summary className="text-sm text-muted-foreground">View</summary>
                            <pre className="mt-2 text-xs bg-muted p-2 rounded overflow-auto max-w-md max-h-64">
                              {JSON.stringify(conv.messages, null, 2)}
                            </pre>
                          </details>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {pagination && pagination.totalPages > 1 && (
                <div className="flex items-center justify-between p-4 border-t">
                  <div className="text-sm text-muted-foreground">
                    Showing {((pagination.page - 1) * pagination.limit) + 1} - {Math.min(pagination.page * pagination.limit, pagination.total)} of {formatNumber(pagination.total)} conversations
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
