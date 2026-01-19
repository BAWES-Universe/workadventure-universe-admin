'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import AuthLink from '@/app/admin/auth-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, Loader2, Database, CheckCircle2, AlertTriangle, Trash2, Eye, RefreshCw, BarChart3, Activity, TrendingUp, ChevronDown, ChevronUp, MessageSquare, Brain } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface TableStats {
  table: string;
  rowCount: number;
  sizeBytes: number;
  oldestRecord: number | null;
  newestRecord: number | null;
  recommendation: string;
}

interface DatabaseStats {
  metrics: TableStats;
  conversations: TableStats;
  memory: TableStats;
  testResults: TableStats;
  improvements: TableStats;
  totalSizeBytes: number;
  totalSizeMB: number;
  recommendations: string[];
}

// Skeleton loader
function SkeletonCard() {
  return (
    <Card>
      <CardHeader>
        <div className="h-6 w-32 bg-muted animate-pulse rounded" />
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <div className="h-4 w-full bg-muted animate-pulse rounded" />
          <div className="h-4 w-3/4 bg-muted animate-pulse rounded" />
        </div>
      </CardContent>
    </Card>
  );
}

export default function DatabaseMonitoringPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<DatabaseStats | null>(null);
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false);
  const [cleanupOptionsDialogOpen, setCleanupOptionsDialogOpen] = useState(false);
  const [cleanupType, setCleanupType] = useState<'metrics' | 'conversations' | 'memory' | 'testResults' | 'improvements' | 'all' | null>(null);
  const [cleanupPreview, setCleanupPreview] = useState<any>(null);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupOptions, setCleanupOptions] = useState({
    strategy: 'deleteAll' as 'deleteAll' | 'olderThanDays' | 'maxPerBot' | 'maxTotal' | 'maxRows',
    olderThanDays: 30,
    maxPerBot: 100,
    maxTotal: 1000,
    maxRows: 1000,
  });

  useEffect(() => {
    checkAuth();
  }, []);

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
      fetchStats();
    } catch (err) {
      router.push('/admin/login');
    }
  }

  async function fetchStats() {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/bots/database/stats');

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          router.push('/admin');
          return;
        }
        throw new Error('Failed to fetch database stats');
      }

      const data = await response.json();
      setStats(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  async function previewCleanup(type: 'metrics' | 'conversations' | 'memory' | 'testResults' | 'improvements' | 'all') {
    // Show options dialog first
    setCleanupType(type);
    setCleanupOptionsDialogOpen(true);
  }

  async function previewCleanupWithOptions() {
    if (!cleanupType) return;
    
    try {
      setCleanupLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      const params = new URLSearchParams();
      
      if (cleanupOptions.strategy === 'deleteAll') {
        params.append('deleteAll', 'true');
      } else if (cleanupOptions.strategy === 'olderThanDays') {
        params.append('olderThanDays', cleanupOptions.olderThanDays.toString());
      } else if (cleanupOptions.strategy === 'maxPerBot') {
        params.append('maxPerBot', cleanupOptions.maxPerBot.toString());
      } else if (cleanupOptions.strategy === 'maxTotal') {
        params.append('maxTotal', cleanupOptions.maxTotal.toString());
      } else if (cleanupOptions.strategy === 'maxRows') {
        params.append('maxRows', cleanupOptions.maxRows.toString());
      }
      
      let url = '';
      if (cleanupType === 'metrics') {
        url = `/api/bots/metrics/cleanup/preview?${params.toString()}`;
      } else if (cleanupType === 'conversations') {
        url = `/api/bots/conversations/cleanup/preview?${params.toString()}`;
      } else if (cleanupType === 'memory') {
        url = `/api/bots/memory/cleanup/preview?${params.toString()}`;
      } else if (cleanupType === 'testResults') {
        url = `/api/bots/test-results/cleanup/preview?${params.toString()}`;
      } else if (cleanupType === 'improvements') {
        url = `/api/bots/improvements/cleanup/preview?${params.toString()}`;
      }

      if (url) {
        const response = await authenticatedFetch(url);
        if (response.ok) {
          const data = await response.json();
          setCleanupPreview(data);
          setCleanupOptionsDialogOpen(false);
          setCleanupDialogOpen(true);
        } else {
          const errorData = await response.json();
          console.error('Preview error:', errorData);
          setError(errorData.error || 'Failed to preview cleanup');
        }
      }
    } catch (err) {
      console.error('Error previewing cleanup:', err);
      setError(err instanceof Error ? err.message : 'Failed to preview cleanup');
    } finally {
      setCleanupLoading(false);
    }
  }

  async function performCleanup() {
    if (!cleanupType) return;
    
    try {
      setCleanupLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      const params = new URLSearchParams();
      
      if (cleanupOptions.strategy === 'deleteAll') {
        params.append('deleteAll', 'true');
      } else if (cleanupOptions.strategy === 'olderThanDays') {
        params.append('olderThanDays', cleanupOptions.olderThanDays.toString());
      } else if (cleanupOptions.strategy === 'maxPerBot') {
        params.append('maxPerBot', cleanupOptions.maxPerBot.toString());
      } else if (cleanupOptions.strategy === 'maxTotal') {
        params.append('maxTotal', cleanupOptions.maxTotal.toString());
      } else if (cleanupOptions.strategy === 'maxRows') {
        params.append('maxRows', cleanupOptions.maxRows.toString());
      }
      
      let url = '';
      if (cleanupType === 'metrics') {
        url = `/api/bots/metrics/cleanup?${params.toString()}`;
      } else if (cleanupType === 'conversations') {
        url = `/api/bots/conversations/cleanup?${params.toString()}`;
      } else if (cleanupType === 'memory') {
        url = `/api/bots/memory/cleanup?${params.toString()}`;
      } else if (cleanupType === 'testResults') {
        url = `/api/bots/test-results/cleanup?${params.toString()}`;
      } else if (cleanupType === 'improvements') {
        url = `/api/bots/improvements/cleanup?${params.toString()}`;
      }

      if (url) {
        const response = await authenticatedFetch(url, { method: 'DELETE' });
        if (response.ok) {
          setCleanupDialogOpen(false);
          setError(null);
          fetchStats(); // Refresh stats
        } else {
          const errorData = await response.json();
          setError(errorData.error || 'Failed to perform cleanup');
        }
      }
    } catch (err) {
      console.error('Error performing cleanup:', err);
      setError(err instanceof Error ? err.message : 'Failed to perform cleanup');
    } finally {
      setCleanupLoading(false);
    }
  }

  async function startFresh() {
    if (!confirm('This will delete ALL data from Metrics, Conversations, Memory, Test Results, and Improvements tables. This action cannot be undone! Are you absolutely sure?')) {
      return;
    }

    try {
      setCleanupLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      // Cleanup all tables
      const tables = ['metrics', 'conversations', 'memory', 'test-results', 'improvements'];
      const results: any[] = [];
      
      for (const table of tables) {
        try {
          const response = await authenticatedFetch(`/api/bots/${table}/cleanup?deleteAll=true`, { method: 'DELETE' });
          if (response.ok) {
            const data = await response.json();
            results.push({ table, ...data });
          }
        } catch (err) {
          console.error(`Error cleaning up ${table}:`, err);
        }
      }
      
      setError(null);
      fetchStats(); // Refresh stats
      
      // Show success message
      alert(`Cleanup complete! Deleted records from ${results.length} tables.`);
    } catch (err) {
      console.error('Error starting fresh:', err);
      setError(err instanceof Error ? err.message : 'Failed to start fresh');
    } finally {
      setCleanupLoading(false);
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }

  function formatNumber(num: number): string {
    return new Intl.NumberFormat().format(num);
  }

  function getHealthStatus(table: TableStats): 'healthy' | 'warning' | 'critical' {
    const sizeMB = table.sizeBytes / (1024 * 1024);
    if (table.rowCount > 1000000 || sizeMB > 500) return 'critical';
    if (table.rowCount > 500000 || sizeMB > 200) return 'warning';
    return 'healthy';
  }

  if (loading) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-4xl font-bold tracking-tight">Bot Database Monitoring</h1>
            <p className="text-muted-foreground text-lg">
              Monitor database size and manage cleanup
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[...Array(5)].map((_, i) => (
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
          <h1 className="text-4xl font-bold tracking-tight">Bot Database Monitoring</h1>
          <p className="text-muted-foreground text-lg">
            Monitor database size and manage cleanup
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={fetchStats} variant="outline">
            Refresh
          </Button>
          <Button 
            onClick={startFresh} 
            variant="destructive"
            disabled={cleanupLoading}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Start Fresh (Dev)
          </Button>
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
              onClick={fetchStats}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {stats && (
        <>
          {/* Total Size Summary */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5" />
                Total Database Size
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold mb-2">
                {formatBytes(stats.totalSizeBytes)}
              </div>
              <div className="text-sm text-muted-foreground">
                {stats.totalSizeMB.toFixed(2)} MB total across all bot tables
              </div>
              {stats.totalSizeBytes > 0 && (
                <Collapsible className="mt-4">
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" className="w-full justify-between hover:bg-muted/50">
                      <div className="flex items-center gap-2">
                        <AlertCircle className="h-4 w-4" />
                        <span className="font-semibold">About Table Sizes</span>
                      </div>
                      <ChevronDown className="h-4 w-4 transition-transform duration-200 data-[state=open]:rotate-180" />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <Alert className="mt-2">
                      <AlertDescription>
                        <p className="text-sm">
                          PostgreSQL table sizes include:
                        </p>
                        <ul className="list-disc list-inside text-sm mt-2 space-y-1">
                          <li>Table data (actual rows)</li>
                          <li>Indexes (for fast queries)</li>
                          <li>Table structure and metadata</li>
                          <li>Unused space from deleted rows (reused automatically)</li>
                        </ul>
                        <p className="text-sm mt-2">
                          After deleting all rows, tables still show size due to indexes and structure. 
                          This is normal PostgreSQL behavior. To reclaim all space, you would need to run 
                          <code className="bg-muted px-1 rounded">VACUUM FULL</code> directly on the database 
                          (not recommended for production).
                        </p>
                      </AlertDescription>
                    </Alert>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </CardContent>
          </Card>

          {/* Recommendations */}
          {stats.recommendations.length > 0 && (
            <Alert variant="default" className="border-yellow-500">
              <AlertTriangle className="h-4 w-4 text-yellow-600" />
              <AlertTitle>Recommendations</AlertTitle>
              <AlertDescription>
                <ul className="list-disc list-inside space-y-1 mt-2">
                  {stats.recommendations.map((rec, idx) => (
                    <li key={idx} className="text-sm">{rec}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {/* Table Stats */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[
              { key: 'metrics', label: 'Metrics', data: stats.metrics },
              { key: 'conversations', label: 'Conversations', data: stats.conversations },
              { key: 'memory', label: 'Memory', data: stats.memory },
              { key: 'testResults', label: 'Test Results', data: stats.testResults },
              { key: 'improvements', label: 'Improvements', data: stats.improvements },
            ].map(({ key, label, data }) => {
              const health = getHealthStatus(data);
              return (
                <Card
                  key={key}
                  className={`group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all hover:-translate-y-1 hover:shadow-lg ${
                    health === 'critical' ? 'border-red-500/50' : health === 'warning' ? 'border-yellow-500/50' : ''
                  }`}
                >
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-purple-500/10 via-transparent to-pink-500/20 opacity-0 transition-opacity group-hover:opacity-100" />
                  <CardHeader className="relative">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">{label}</CardTitle>
                      {health === 'healthy' ? (
                        <Badge variant="default" className="bg-green-600">
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                          Healthy
                        </Badge>
                      ) : health === 'warning' ? (
                        <Badge variant="default" className="bg-yellow-600">
                          <AlertTriangle className="mr-1 h-3 w-3" />
                          Warning
                        </Badge>
                      ) : (
                        <Badge variant="destructive">
                          <AlertTriangle className="mr-1 h-3 w-3" />
                          Critical
                        </Badge>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="relative space-y-3">
                    <div>
                      <div className="text-sm font-medium text-muted-foreground">Row Count</div>
                      <div className="text-2xl font-bold">{formatNumber(data.rowCount)}</div>
                    </div>
                    <div>
                      <div className="text-sm font-medium text-muted-foreground">Size</div>
                      <div className="text-lg font-semibold">{formatBytes(data.sizeBytes)}</div>
                      {data.rowCount === 0 && data.sizeBytes > 0 && (
                        <div className="text-xs text-muted-foreground mt-1">
                          (table overhead - indexes & structure)
                        </div>
                      )}
                      {data.rowCount > 0 && data.sizeBytes > 0 && (data.sizeBytes / data.rowCount) > 1024 * 1024 && (
                        <div className="text-xs text-yellow-600 mt-1">
                          ⚠️ Large average row size: {formatBytes(data.sizeBytes / data.rowCount)} per row
                        </div>
                      )}
                    </div>
                    {data.oldestRecord && (
                      <div>
                        <div className="text-sm font-medium text-muted-foreground">Oldest Record</div>
                        <div className="text-sm">{new Date(data.oldestRecord).toLocaleDateString()}</div>
                      </div>
                    )}
                    {data.newestRecord && (
                      <div>
                        <div className="text-sm font-medium text-muted-foreground">Newest Record</div>
                        <div className="text-sm">{new Date(data.newestRecord).toLocaleDateString()}</div>
                      </div>
                    )}
                    <div className="pt-2 border-t">
                      <div className="text-xs text-muted-foreground">{data.recommendation}</div>
                      {data.rowCount === 0 && data.sizeBytes > 0 && (
                        <div className="text-xs text-muted-foreground mt-1 italic">
                          Size includes table structure, indexes, and unused space from previous rows
                        </div>
                      )}
                      {key === 'testResults' && data.rowCount > 0 && data.sizeBytes > 5 * 1024 * 1024 && (
                        <div className="text-xs text-yellow-600 mt-1">
                          Large size may indicate very large JSON data in test results. Check the browse page to inspect.
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2 pt-2 flex-wrap">
                      {(key === 'metrics' || key === 'testResults' || key === 'improvements' || key === 'conversations' || key === 'memory') && (
                        <AuthLink href={
                          key === 'metrics' ? '/admin/bots/metrics' :
                          key === 'testResults' ? '/admin/bots/test-results' :
                          key === 'improvements' ? '/admin/bots/improvements' :
                          key === 'conversations' ? '/admin/bots/conversations' :
                          '/admin/bots/memory'
                        }>
                          <Button variant="outline" size="sm">
                            {key === 'metrics' && <BarChart3 className="mr-2 h-4 w-4" />}
                            {key === 'testResults' && <Activity className="mr-2 h-4 w-4" />}
                            {key === 'improvements' && <TrendingUp className="mr-2 h-4 w-4" />}
                            {key === 'conversations' && <MessageSquare className="mr-2 h-4 w-4" />}
                            {key === 'memory' && <Brain className="mr-2 h-4 w-4" />}
                            Browse
                          </Button>
                        </AuthLink>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => previewCleanup(key as 'metrics' | 'conversations' | 'memory' | 'testResults' | 'improvements')}
                        disabled={cleanupLoading}
                      >
                        <Eye className="mr-2 h-4 w-4" />
                        Cleanup
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

        </>
      )}

      {/* Cleanup Options Dialog */}
      <AlertDialog open={cleanupOptionsDialogOpen} onOpenChange={setCleanupOptionsDialogOpen}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Choose Cleanup Strategy</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label>Cleanup Strategy</Label>
                  <Select
                    value={cleanupOptions.strategy}
                    onValueChange={(value) => setCleanupOptions({ ...cleanupOptions, strategy: value as any })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="deleteAll">Delete All (Start Fresh)</SelectItem>
                      <SelectItem value="olderThanDays">Delete Older Than X Days</SelectItem>
                      {(cleanupType === 'memory' || cleanupType === 'testResults' || cleanupType === 'improvements') && (
                        <SelectItem value="olderThanDays">Delete Older Than X Days</SelectItem>
                      )}
                      {cleanupType === 'metrics' && (
                        <>
                          <SelectItem value="olderThanDays">Delete Older Than X Days</SelectItem>
                          <SelectItem value="maxRows">Keep Last N Rows Per Bot</SelectItem>
                        </>
                      )}
                      {cleanupType === 'conversations' && (
                        <>
                          <SelectItem value="olderThanDays">Delete Older Than X Days</SelectItem>
                          <SelectItem value="maxPerBot">Keep Last N Per Bot</SelectItem>
                          <SelectItem value="maxTotal">Keep Last N Total</SelectItem>
                        </>
                      )}
                    </SelectContent>
                  </Select>
                </div>

                {cleanupOptions.strategy === 'olderThanDays' && (
                  <div className="space-y-2">
                    <Label htmlFor="olderThanDays">Days</Label>
                    <Input
                      id="olderThanDays"
                      type="number"
                      min="1"
                      value={cleanupOptions.olderThanDays}
                      onChange={(e) => setCleanupOptions({ ...cleanupOptions, olderThanDays: parseInt(e.target.value) || 30 })}
                    />
                  </div>
                )}

                {cleanupOptions.strategy === 'maxPerBot' && (
                  <div className="space-y-2">
                    <Label htmlFor="maxPerBot">Keep Last N Per Bot</Label>
                    <Input
                      id="maxPerBot"
                      type="number"
                      min="1"
                      value={cleanupOptions.maxPerBot}
                      onChange={(e) => setCleanupOptions({ ...cleanupOptions, maxPerBot: parseInt(e.target.value) || 100 })}
                    />
                  </div>
                )}

                {cleanupOptions.strategy === 'maxTotal' && (
                  <div className="space-y-2">
                    <Label htmlFor="maxTotal">Keep Last N Total</Label>
                    <Input
                      id="maxTotal"
                      type="number"
                      min="1"
                      value={cleanupOptions.maxTotal}
                      onChange={(e) => setCleanupOptions({ ...cleanupOptions, maxTotal: parseInt(e.target.value) || 1000 })}
                    />
                  </div>
                )}

                {cleanupOptions.strategy === 'maxRows' && (
                  <div className="space-y-2">
                    <Label htmlFor="maxRows">Keep Last N Rows Per Bot</Label>
                    <Input
                      id="maxRows"
                      type="number"
                      min="1"
                      value={cleanupOptions.maxRows}
                      onChange={(e) => setCleanupOptions({ ...cleanupOptions, maxRows: parseInt(e.target.value) || 1000 })}
                    />
                  </div>
                )}

                {cleanupOptions.strategy === 'deleteAll' && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                      This will delete ALL {cleanupType} data. This action cannot be undone!
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={previewCleanupWithOptions} disabled={cleanupLoading}>
              {cleanupLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading...
                </>
              ) : (
                <>
                  <Eye className="mr-2 h-4 w-4" />
                  Preview Cleanup
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cleanup Preview Dialog */}
      <AlertDialog open={cleanupDialogOpen} onOpenChange={setCleanupDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cleanup Preview</AlertDialogTitle>
            <AlertDialogDescription asChild>
              {cleanupPreview ? (
                <div className="space-y-2 mt-4">
                  {cleanupPreview.note ? (
                    <p className="text-sm">{cleanupPreview.note}</p>
                  ) : (
                    <>
                      <p>
                        <strong>Will delete:</strong> {cleanupPreview.willDelete?.conversationCount || cleanupPreview.willDelete?.metricCount || cleanupPreview.willDelete?.rowCount || 0} records
                      </p>
                      <p>
                        <strong>Will keep:</strong> {cleanupPreview.willKeep?.conversationCount || cleanupPreview.willKeep?.metricCount || cleanupPreview.willKeep?.rowCount || 0} records
                      </p>
                      {cleanupPreview.willDelete?.estimatedSizeBytes && (
                        <p>
                          <strong>Estimated space freed:</strong> {formatBytes(cleanupPreview.willDelete.estimatedSizeBytes)}
                        </p>
                      )}
                      {cleanupPreview.willDelete?.botsAffected && (
                        <p>
                          <strong>Bots affected:</strong> {cleanupPreview.willDelete.botsAffected}
                        </p>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <p>Loading preview...</p>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={performCleanup}
              disabled={cleanupLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cleanupLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Cleaning up...
                </>
              ) : (
                <>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Confirm Cleanup
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
