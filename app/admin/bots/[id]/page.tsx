'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import AuthLink from '@/app/admin/auth-link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, Loader2, ArrowLeft, Activity, TrendingUp, DollarSign, AlertTriangle } from 'lucide-react';

interface Bot {
  id: string;
  name: string;
  description: string | null;
  characterTextureId: string | null;
  enabled: boolean;
  behaviorType: string;
  behaviorConfig: any;
  chatInstructions: string | null;
  movementInstructions: string | null;
  aiProviderRef: string | null;
  createdAt: string;
  updatedAt: string;
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
  updatedBy: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
}

interface UsageEntry {
  id: number;
  botId: string;
  providerId: string;
  tokensUsed: number;
  apiCalls: number;
  durationSeconds: number | null;
  cost: number | null;
  latency: number | null;
  error: boolean;
  timestamp: string;
  provider: {
    providerId: string;
    name: string;
    type: string;
  };
}

interface UsageStats {
  totalCalls: number;
  totalTokens: number;
  totalCost: number;
  totalDuration: number;
  errorCount: number;
  byProvider: Record<string, {
    providerId: string;
    providerName: string;
    providerType: string;
    calls: number;
    tokens: number;
    cost: number;
    duration: number;
    errors: number;
  }>;
}

export default function BotDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const [botId, setBotId] = useState<string>('');
  
  const [bot, setBot] = useState<Bot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageEntry[]>([]);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [totalEntries, setTotalEntries] = useState(0);
  const [authChecked, setAuthChecked] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const [filters, setFilters] = useState({
    startDate: '',
    endDate: '',
  });

  useEffect(() => {
    async function init() {
      // Get bot ID from params
      const resolvedParams = await params;
      setBotId(resolvedParams.id);
      
      // Check auth
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
        setAuthChecked(true);
        // Don't set loading to false here - wait for fetchBot to complete
      } catch (err) {
        router.push('/admin/login');
      }
    }
    init();
  }, [params, router]);

  const fetchBot = useCallback(async () => {
    if (!botId) return;
    
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      const queryParams = new URLSearchParams();
      if (filters.startDate) queryParams.append('startDate', filters.startDate);
      if (filters.endDate) queryParams.append('endDate', filters.endDate);

      const response = await authenticatedFetch(`/api/admin/bots/${botId}?${queryParams.toString()}`);

      if (!response.ok) {
        if (response.status === 404) {
          setError('Bot not found');
          setLoading(false);
          return;
        }
        if (response.status === 401 || response.status === 403) {
          router.push('/admin');
          return;
        }
        throw new Error('Failed to fetch bot details');
      }

      const data = await response.json();
      setBot(data.bot);
      setUsage(data.usage);
      setStats(data.stats);
      setTotalEntries(data.totalEntries);
      
      // If bot doesn't exist but we have usage data, show a warning
      if (!data.botExists && data.usage && data.usage.length > 0) {
        setError('Bot was deleted, but usage history is preserved below.');
      } else if (!data.botExists) {
        setError('Bot not found');
      } else {
        setError(null);
      }
      
      setInitialLoad(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setInitialLoad(false);
    } finally {
      setLoading(false);
    }
  }, [botId, filters, router]);

  useEffect(() => {
    if (botId && authChecked) {
      fetchBot();
    }
  }, [botId, authChecked, fetchBot]);

  function formatNumber(num: number): string {
    return new Intl.NumberFormat().format(num);
  }

  function formatCurrency(amount: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount);
  }

  function formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  function formatDate(dateString: string): string {
    return new Date(dateString).toLocaleString();
  }

  // Show loading spinner during initial load
  if (loading || initialLoad) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  // Only show "not found" if we've completed the initial load and bot is null
  if (!bot && !initialLoad) {
    return (
      <div className="space-y-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Bot not found</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" asChild>
            <AuthLink href="/admin/ai-providers/usage">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </AuthLink>
          </Button>
          <div className="space-y-1">
            <h1 className="text-4xl font-bold tracking-tight">{bot ? bot.name : 'Bot Usage History'}</h1>
            <p className="text-muted-foreground text-lg">
              Bot details and usage history
            </p>
          </div>
        </div>
      </div>

      {error && (
        <Alert variant={error.includes('deleted') ? 'default' : 'destructive'}>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Bot Details */}
      {bot && (
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Basic Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="text-sm font-medium text-muted-foreground">Bot ID</div>
              <div className="text-base font-mono text-sm">{bot.id}</div>
            </div>
            <div>
              <div className="text-sm font-medium text-muted-foreground">Name</div>
              <div className="text-base">{bot.name}</div>
            </div>
            {bot.description && (
              <div>
                <div className="text-sm font-medium text-muted-foreground">Description</div>
                <div className="text-base">{bot.description}</div>
              </div>
            )}
            <div>
              <div className="text-sm font-medium text-muted-foreground">Status</div>
              <Badge variant={bot.enabled ? 'default' : 'secondary'}>
                {bot.enabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </div>
            {bot.aiProviderRef && (
              <div>
                <div className="text-sm font-medium text-muted-foreground">AI Provider</div>
                <AuthLink
                  href={`/admin/ai-providers/${bot.aiProviderRef}`}
                  className="text-base text-primary hover:underline"
                >
                  {bot.aiProviderRef}
                </AuthLink>
              </div>
            )}
            <div>
              <div className="text-sm font-medium text-muted-foreground">Behavior Type</div>
              <Badge variant="outline">{bot.behaviorType}</Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Location</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="text-sm font-medium text-muted-foreground">Room</div>
              <AuthLink
                href={`/admin/rooms/${bot.room.id}`}
                className="text-base text-primary hover:underline"
              >
                {bot.room.name}
              </AuthLink>
            </div>
            <div>
              <div className="text-sm font-medium text-muted-foreground">World</div>
              <AuthLink
                href={`/admin/worlds/${bot.room.world.id}`}
                className="text-base text-primary hover:underline"
              >
                {bot.room.world.name}
              </AuthLink>
            </div>
            <div>
              <div className="text-sm font-medium text-muted-foreground">Universe</div>
              <AuthLink
                href={`/admin/universes/${bot.room.world.universe.id}`}
                className="text-base text-primary hover:underline"
              >
                {bot.room.world.universe.name}
              </AuthLink>
            </div>
            {bot.createdBy && (
              <div>
                <div className="text-sm font-medium text-muted-foreground">Created By</div>
                <div className="text-base">{bot.createdBy.name || bot.createdBy.email}</div>
              </div>
            )}
            <div>
              <div className="text-sm font-medium text-muted-foreground">Created At</div>
              <div className="text-base">{formatDate(bot.createdAt)}</div>
            </div>
          </CardContent>
        </Card>
      </div>
      )}

      {/* Usage Statistics */}
      {stats && (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-5">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total API Calls</CardTitle>
                <Activity className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatNumber(stats.totalCalls)}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Tokens</CardTitle>
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatNumber(stats.totalTokens)}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Cost</CardTitle>
                <DollarSign className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatCurrency(stats.totalCost)}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Duration</CardTitle>
                <Activity className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {formatDuration(stats.totalDuration)}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Errors</CardTitle>
                <AlertTriangle className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatNumber(stats.errorCount)}</div>
                <p className="text-xs text-muted-foreground">
                  {stats.totalCalls > 0
                    ? `${((stats.errorCount / stats.totalCalls) * 100).toFixed(2)}% error rate`
                    : 'N/A'}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Usage by Provider */}
          {Object.keys(stats.byProvider).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Usage by Provider</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {Object.values(stats.byProvider).map((provider) => (
                    <div
                      key={provider.providerId}
                      className="flex items-center justify-between border-b pb-4 last:border-0"
                    >
                      <div>
                        <AuthLink
                          href={`/admin/ai-providers/${provider.providerId}`}
                          className="font-semibold text-primary hover:underline"
                        >
                          {provider.providerName}
                        </AuthLink>
                        <div className="text-sm text-muted-foreground">
                          {provider.providerType} • {provider.providerId}
                        </div>
                      </div>
                      <div className="text-right space-y-1">
                        <div className="text-sm">
                          {formatNumber(provider.calls)} calls • {formatNumber(provider.tokens)} tokens
                        </div>
                        <div className="text-sm font-medium">
                          {formatCurrency(provider.cost)}
                        </div>
                        {provider.errors > 0 && (
                          <div className="text-xs text-destructive">
                            {provider.errors} errors
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="startDate">Start Date</Label>
              <Input
                id="startDate"
                type="date"
                value={filters.startDate}
                onChange={(e) => setFilters({ ...filters, startDate: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="endDate">End Date</Label>
              <Input
                id="endDate"
                type="date"
                value={filters.endDate}
                onChange={(e) => setFilters({ ...filters, endDate: e.target.value })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Usage History Table */}
      <Card>
        <CardHeader>
          <CardTitle>Usage History</CardTitle>
        </CardHeader>
        <CardContent>
          {usage.length === 0 ? (
            <p className="text-sm text-muted-foreground">No usage data available</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>API Calls</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead>Cost</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Latency</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usage.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell>{formatDate(entry.timestamp)}</TableCell>
                      <TableCell>
                        <AuthLink
                          href={`/admin/ai-providers/${entry.provider.providerId}`}
                          className="text-primary hover:underline"
                        >
                          {entry.provider.name}
                        </AuthLink>
                      </TableCell>
                      <TableCell>{formatNumber(entry.apiCalls)}</TableCell>
                      <TableCell>{formatNumber(entry.tokensUsed)}</TableCell>
                      <TableCell>
                        {entry.cost ? formatCurrency(entry.cost) : 'N/A'}
                      </TableCell>
                      <TableCell>
                        {entry.durationSeconds ? formatDuration(entry.durationSeconds) : 'N/A'}
                      </TableCell>
                      <TableCell>
                        {entry.latency ? `${entry.latency}ms` : 'N/A'}
                      </TableCell>
                      <TableCell>
                        {entry.error ? (
                          <Badge variant="destructive">Error</Badge>
                        ) : (
                          <Badge variant="default">Success</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {totalEntries > 0 && (
        <p className="text-sm text-muted-foreground text-center">
          Showing {totalEntries} usage entries
        </p>
      )}
    </div>
  );
}

