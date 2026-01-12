'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Loader2, TrendingUp, DollarSign, Activity, AlertTriangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

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
  byBot: Record<string, {
    botId: string;
    calls: number;
    tokens: number;
    cost: number;
    duration: number;
    errors: number;
  }>;
}

export default function UsageDashboardPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [totalEntries, setTotalEntries] = useState(0);

  const [filters, setFilters] = useState({
    startDate: '',
    endDate: '',
    providerId: '',
    botId: '',
  });

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (!loading) {
      fetchUsage();
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
      fetchUsage();
    } catch (err) {
      router.push('/admin/login');
    }
  }

  async function fetchUsage() {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      const params = new URLSearchParams();
      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);
      if (filters.providerId) params.append('providerId', filters.providerId);
      if (filters.botId) params.append('botId', filters.botId);

      const response = await authenticatedFetch(`/api/admin/ai-providers/usage?${params.toString()}`);

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          router.push('/admin');
          return;
        }
        throw new Error('Failed to fetch usage data');
      }

      const data = await response.json();
      setStats(data.stats);
      setTotalEntries(data.totalEntries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

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

  if (loading && !stats) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-4xl font-bold tracking-tight">AI Usage Dashboard</h1>
        <p className="text-muted-foreground text-lg">
          Track AI provider usage, costs, and performance
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error}
            <Button
              variant="outline"
              size="sm"
              className="ml-4"
              onClick={fetchUsage}
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
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
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
            <div className="space-y-2">
              <Label htmlFor="providerId">Provider ID</Label>
              <Input
                id="providerId"
                value={filters.providerId}
                onChange={(e) => setFilters({ ...filters, providerId: e.target.value })}
                placeholder="Filter by provider"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="botId">Bot ID</Label>
              <Input
                id="botId"
                value={filters.botId}
                onChange={(e) => setFilters({ ...filters, botId: e.target.value })}
                placeholder="Filter by bot"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary Stats */}
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

          {/* By Provider */}
          <Card>
            <CardHeader>
              <CardTitle>Usage by Provider</CardTitle>
            </CardHeader>
            <CardContent>
              {Object.keys(stats.byProvider).length === 0 ? (
                <p className="text-sm text-muted-foreground">No usage data by provider</p>
              ) : (
                <div className="space-y-4">
                  {Object.values(stats.byProvider).map((provider) => (
                    <div
                      key={provider.providerId}
                      className="flex items-center justify-between border-b pb-4 last:border-0"
                    >
                      <div>
                        <div className="font-semibold">{provider.providerName}</div>
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
              )}
            </CardContent>
          </Card>

          {/* By Bot */}
          <Card>
            <CardHeader>
              <CardTitle>Usage by Bot</CardTitle>
            </CardHeader>
            <CardContent>
              {Object.keys(stats.byBot).length === 0 ? (
                <p className="text-sm text-muted-foreground">No usage data by bot</p>
              ) : (
                <div className="space-y-4">
                  {Object.entries(stats.byBot)
                    .sort((a, b) => b[1].calls - a[1].calls)
                    .map(([botId, bot]) => (
                      <div
                        key={botId}
                        className="flex items-center justify-between border-b pb-4 last:border-0"
                      >
                        <div>
                          <div className="font-semibold">{botId}</div>
                        </div>
                        <div className="text-right space-y-1">
                          <div className="text-sm">
                            {formatNumber(bot.calls)} calls • {formatNumber(bot.tokens)} tokens
                          </div>
                          <div className="text-sm font-medium">
                            {formatCurrency(bot.cost)}
                          </div>
                          {bot.errors > 0 && (
                            <div className="text-xs text-destructive">
                              {bot.errors} errors
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {totalEntries > 0 && (
        <p className="text-sm text-muted-foreground text-center">
          Showing {totalEntries} usage entries
        </p>
      )}
    </div>
  );
}

