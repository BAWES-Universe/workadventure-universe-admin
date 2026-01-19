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
import { AlertCircle, Loader2, BarChart3, ArrowLeft, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface Metric {
  id: number;
  botId: string;
  metricType: string;
  metricValue: number;
  metadata: any;
  timestamp: Date;
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
      <TableCell><div className="h-4 w-32 bg-muted animate-pulse rounded" /></TableCell>
      <TableCell><div className="h-4 w-24 bg-muted animate-pulse rounded" /></TableCell>
      <TableCell><div className="h-4 w-20 bg-muted animate-pulse rounded" /></TableCell>
      <TableCell><div className="h-4 w-32 bg-muted animate-pulse rounded" /></TableCell>
      <TableCell><div className="h-4 w-40 bg-muted animate-pulse rounded" /></TableCell>
    </TableRow>
  );
}

export default function MetricsBrowsePage() {
  const router = useRouter();
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [filters, setFilters] = useState({
    botId: '',
    metricType: '',
    startDate: '',
    endDate: '',
    page: 1,
    limit: 50,
  });
  const [botIdInput, setBotIdInput] = useState('');

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (!loading) {
      const timer = setTimeout(() => {
        fetchMetrics();
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
      fetchMetrics();
    } catch (err) {
      router.push('/admin/login');
    }
  }

  const fetchMetrics = useCallback(async () => {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      const params = new URLSearchParams();
      params.append('page', filters.page.toString());
      params.append('limit', filters.limit.toString());
      if (filters.botId) params.append('botId', filters.botId);
      if (filters.metricType) params.append('metricType', filters.metricType);
      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);

      const response = await authenticatedFetch(`/api/admin/bots/metrics?${params.toString()}`);

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          router.push('/admin');
          return;
        }
        throw new Error('Failed to fetch metrics');
      }

      const data = await response.json();
      setMetrics(data.metrics || []);
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

  // Get unique metric types for filter
  const metricTypes = Array.from(new Set(metrics.map(m => m.metricType))).sort();

  if (loading && metrics.length === 0) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-4xl font-bold tracking-tight">Browse Metrics</h1>
            <p className="text-muted-foreground text-lg">
              View and filter all bot metrics
            </p>
          </div>
        </div>
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Bot ID</TableHead>
                  <TableHead>Metric Type</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Metadata</TableHead>
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
            <h1 className="text-4xl font-bold tracking-tight">Browse Metrics</h1>
            <p className="text-muted-foreground text-lg">
              View and filter all bot metrics
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
              onClick={fetchMetrics}
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
              <Label htmlFor="metricType">Metric Type</Label>
              <Select
                value={filters.metricType}
                onValueChange={(value) => setFilters({ ...filters, metricType: value === 'all' ? '' : value, page: 1 })}
              >
                <SelectTrigger id="metricType">
                  <SelectValue placeholder="All types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {metricTypes.map((type) => (
                    <SelectItem key={type} value={type}>{type}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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

      {/* Metrics Table */}
      <Card>
        <CardHeader>
          <CardTitle>Metrics</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {metrics.length === 0 ? (
            <div className="py-12 text-center">
              <BarChart3 className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
              <h3 className="text-lg font-semibold mb-2">No metrics found</h3>
              <p className="text-sm text-muted-foreground">
                {Object.values(filters).some(v => v && v !== '1' && v !== '50')
                  ? 'Try adjusting your filters to see more results.'
                  : 'No metrics have been recorded yet.'}
              </p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Bot ID</TableHead>
                      <TableHead>Metric Type</TableHead>
                      <TableHead>Value</TableHead>
                      <TableHead>Timestamp</TableHead>
                      <TableHead>Metadata</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {metrics.map((metric) => (
                      <TableRow key={metric.id}>
                        <TableCell>
                          <AuthLink
                            href={`/admin/bots/${metric.botId}`}
                            className="text-primary hover:underline font-mono text-sm"
                          >
                            {metric.botId}
                          </AuthLink>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{metric.metricType}</Badge>
                        </TableCell>
                        <TableCell className="font-mono">
                          {formatNumber(Number(metric.metricValue))}
                        </TableCell>
                        <TableCell>{formatDate(metric.timestamp)}</TableCell>
                        <TableCell>
                          {metric.metadata ? (
                            <details className="cursor-pointer">
                              <summary className="text-sm text-muted-foreground">View</summary>
                              <pre className="mt-2 text-xs bg-muted p-2 rounded overflow-auto max-w-md">
                                {JSON.stringify(metric.metadata, null, 2)}
                              </pre>
                            </details>
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
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
                    Showing {((pagination.page - 1) * pagination.limit) + 1} - {Math.min(pagination.page * pagination.limit, pagination.total)} of {formatNumber(pagination.total)} metrics
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
