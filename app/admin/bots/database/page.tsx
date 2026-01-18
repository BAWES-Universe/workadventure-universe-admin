'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import AuthLink from '@/app/admin/auth-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, Loader2, Database, CheckCircle2, AlertTriangle, Trash2, Eye } from 'lucide-react';
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
  const [cleanupType, setCleanupType] = useState<'metrics' | 'conversations' | 'all' | null>(null);
  const [cleanupPreview, setCleanupPreview] = useState<any>(null);
  const [cleanupLoading, setCleanupLoading] = useState(false);

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

  async function previewCleanup(type: 'metrics' | 'conversations' | 'all') {
    try {
      setCleanupLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      let url = '';
      if (type === 'metrics') {
        url = '/api/bots/metrics/cleanup/preview?olderThanDays=30';
      } else if (type === 'conversations') {
        // Use a specific bot's preview endpoint or show general info
        // For now, show a message that cleanup should be done per-bot
        setCleanupPreview({
          note: 'Conversation cleanup should be performed per-bot from the bot detail page.',
        });
        setCleanupType(type);
        setCleanupDialogOpen(true);
        return;
      }

      if (url) {
        const response = await authenticatedFetch(url);
        if (response.ok) {
          const data = await response.json();
          setCleanupPreview(data);
          setCleanupType(type);
          setCleanupDialogOpen(true);
        }
      }
    } catch (err) {
      console.error('Error previewing cleanup:', err);
    } finally {
      setCleanupLoading(false);
    }
  }

  async function performCleanup() {
    if (!cleanupType) return;
    
    try {
      setCleanupLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      let url = '';
      if (cleanupType === 'metrics') {
        // Note: Metrics cleanup endpoint would need to be created
        // For now, show a message
        alert('Metrics cleanup endpoint not yet implemented. Please use database tools directly.');
        setCleanupDialogOpen(false);
        return;
      } else if (cleanupType === 'conversations') {
        url = '/api/bots/conversations/cleanup?olderThanDays=30';
      }

      if (url) {
        const response = await authenticatedFetch(url, { method: 'DELETE' });
        if (response.ok) {
          setCleanupDialogOpen(false);
          fetchStats(); // Refresh stats
        }
      }
    } catch (err) {
      console.error('Error performing cleanup:', err);
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
        <Button onClick={fetchStats} variant="outline">
          Refresh
        </Button>
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
                {stats.totalSizeBytes > 0 && Object.values({
                  metrics: stats.metrics,
                  conversations: stats.conversations,
                  memory: stats.memory,
                  testResults: stats.testResults,
                  improvements: stats.improvements,
                }).every(t => t.rowCount === 0) && (
                  <div className="mt-2 text-xs italic">
                    Note: Empty tables still have overhead from indexes and metadata
                  </div>
                )}
              </div>
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
                          (table overhead)
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
                          Size includes table structure and indexes
                        </div>
                      )}
                    </div>
                    {(key === 'metrics' || key === 'conversations') && (
                      <div className="flex gap-2 pt-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => previewCleanup(key as 'metrics' | 'conversations')}
                          disabled={cleanupLoading}
                        >
                          <Eye className="mr-2 h-4 w-4" />
                          Preview Cleanup
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Detailed Table View */}
          <Card>
            <CardHeader>
              <CardTitle>Detailed Statistics</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Table</TableHead>
                      <TableHead>Row Count</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead>Oldest Record</TableHead>
                      <TableHead>Newest Record</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[
                      { key: 'metrics', label: 'Metrics', data: stats.metrics },
                      { key: 'conversations', label: 'Conversations', data: stats.conversations },
                      { key: 'memory', label: 'Memory', data: stats.memory },
                      { key: 'testResults', label: 'Test Results', data: stats.testResults },
                      { key: 'improvements', label: 'Improvements', data: stats.improvements },
                    ].map(({ key, label, data }) => {
                      const health = getHealthStatus(data);
                      return (
                        <TableRow key={key}>
                          <TableCell className="font-medium">{label}</TableCell>
                          <TableCell>{formatNumber(data.rowCount)}</TableCell>
                          <TableCell>{formatBytes(data.sizeBytes)}</TableCell>
                          <TableCell>
                            {data.oldestRecord
                              ? new Date(data.oldestRecord).toLocaleDateString()
                              : 'N/A'}
                          </TableCell>
                          <TableCell>
                            {data.newestRecord
                              ? new Date(data.newestRecord).toLocaleDateString()
                              : 'N/A'}
                          </TableCell>
                          <TableCell>
                            {health === 'healthy' ? (
                              <Badge variant="default" className="bg-green-600">
                                Healthy
                              </Badge>
                            ) : health === 'warning' ? (
                              <Badge variant="default" className="bg-yellow-600">
                                Warning
                              </Badge>
                            ) : (
                              <Badge variant="destructive">Critical</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Cleanup Preview Dialog */}
      <AlertDialog open={cleanupDialogOpen} onOpenChange={setCleanupDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cleanup Preview</AlertDialogTitle>
            <AlertDialogDescription>
              {cleanupPreview ? (
                <div className="space-y-2 mt-4">
                  <div>
                    <strong>Will delete:</strong> {cleanupPreview.willDelete?.conversationCount || cleanupPreview.willDelete?.rowCount || 0} records
                  </div>
                  <div>
                    <strong>Will keep:</strong> {cleanupPreview.willKeep?.conversationCount || cleanupPreview.willKeep?.rowCount || 0} records
                  </div>
                  {cleanupPreview.willDelete?.estimatedSizeBytes && (
                    <div>
                      <strong>Estimated space freed:</strong> {formatBytes(cleanupPreview.willDelete.estimatedSizeBytes)}
                    </div>
                  )}
                </div>
              ) : (
                'Loading preview...'
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
