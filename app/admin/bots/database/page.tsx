'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, Loader2, AlertTriangle, Trash2, Eye, RefreshCw, BarChart3, Activity, ChevronDown, MessageSquare, Brain } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Figure, Figures, LoadError, LoadingRows, PageHeader, SectionHeader } from '../../components/ds';
import { Detail, Pill } from '../bots-ui';
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
  totalSizeBytes: number;
  totalSizeMB: number;
  recommendations: string[];
}

export default function BotDatabasePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<DatabaseStats | null>(null);
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false);
  const [cleanupOptionsDialogOpen, setCleanupOptionsDialogOpen] = useState(false);
  const [cleanupType, setCleanupType] = useState<'metrics' | 'conversations' | 'memory' | 'testResults' | 'all' | null>(null);
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

  async function previewCleanup(type: 'metrics' | 'conversations' | 'memory' | 'testResults' | 'all') {
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
    if (!confirm('This will delete ALL data from Metrics, Conversations, Memory, and Test Results tables. This action cannot be undone! Are you absolutely sure?')) {
      return;
    }

    try {
      setCleanupLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      // Cleanup all tables
      const tables = ['metrics', 'conversations', 'memory', 'test-results'];
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


  function getHealthStatus(table: TableStats): 'healthy' | 'warning' | 'critical' {
    const sizeMB = table.sizeBytes / (1024 * 1024);
    if (table.rowCount > 1000000 || sizeMB > 500) return 'critical';
    if (table.rowCount > 500000 || sizeMB > 200) return 'warning';
    return 'healthy';
  }

  const tables = stats
    ? [
        { key: 'metrics', label: 'Metrics', href: '/admin/bots/metrics', icon: BarChart3, data: stats.metrics },
        { key: 'conversations', label: 'Conversations', href: '/admin/bots/conversations', icon: MessageSquare, data: stats.conversations },
        { key: 'memory', label: 'Memory', href: '/admin/bots/memory', icon: Brain, data: stats.memory },
        { key: 'testResults', label: 'Test results', href: '/admin/bots/test-results', icon: Activity, data: stats.testResults },
      ] as const
    : [];

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        kind="bot"
        title="Bot database"
        context={<span>How much each bot table holds, and cleanup.</span>}
        stats={
          stats ? (
            <Figures>
              <Figure value={formatBytes(stats.totalSizeBytes)} label="total size" />
              {tables.map(({ key, label, data }) => (
                <Figure key={key} value={data.rowCount} label={`${label.toLowerCase()} rows`} />
              ))}
            </Figures>
          ) : undefined
        }
        actions={
          <>
            <Button onClick={fetchStats} variant="outline" disabled={loading}>
              <RefreshCw aria-hidden="true" />
              Refresh
            </Button>
            <Button onClick={startFresh} variant="destructive" disabled={cleanupLoading}>
              <Trash2 aria-hidden="true" />
              Start fresh (dev)
            </Button>
          </>
        }
      />

      {error && stats && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && !stats ? (
        <LoadingRows label="database sizes" rows={4} />
      ) : !stats ? (
        error && <LoadError label="database sizes" retry={fetchStats} />
      ) : (
        <>
          {stats.recommendations.length > 0 && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Recommendations</AlertTitle>
              <AlertDescription>
                <ul className="mt-2 list-inside list-disc space-y-1">
                  {stats.recommendations.map((rec, idx) => (
                    <li key={idx} className="text-sm">{rec}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          <section aria-labelledby="db-tables" className="min-w-0">
            <SectionHeader id="db-tables" title="Tables" count={tables.length} />
            <p className="mb-3 text-sm text-muted-foreground">
              {stats.totalSizeMB.toFixed(2)} MB across all bot tables.
            </p>
            <div className="grid min-w-0 gap-3 md:grid-cols-2">
              {tables.map(({ key, label, href, icon: Icon, data }) => {
                const health = getHealthStatus(data);
                return (
                  <article key={key} className="flex min-w-0 flex-col gap-4 rounded-2xl border bg-card p-4 sm:p-5">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="orbit-display flex items-center gap-2 text-base font-semibold">
                        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                        {label}
                      </h3>
                      <Pill tone={health === 'healthy' ? 'ok' : health === 'warning' ? 'waiting' : 'bad'}>
                        {health === 'healthy' ? 'Healthy' : health === 'warning' ? 'Warning' : 'Critical'}
                      </Pill>
                    </div>

                    <Figures>
                      <Figure value={data.rowCount} label="rows" />
                      <Figure value={formatBytes(data.sizeBytes)} label="size" />
                    </Figures>

                    <dl className="grid grid-cols-2 gap-3">
                      {data.oldestRecord && <Detail label="Oldest record">{new Date(data.oldestRecord).toLocaleDateString()}</Detail>}
                      {data.newestRecord && <Detail label="Newest record">{new Date(data.newestRecord).toLocaleDateString()}</Detail>}
                    </dl>

                    <div className="space-y-1 text-xs text-muted-foreground">
                      <p>{data.recommendation}</p>
                      {data.rowCount === 0 && data.sizeBytes > 0 && (
                        <p>The size is table overhead: structure, indexes and space left by earlier rows.</p>
                      )}
                      {data.rowCount > 0 && data.sizeBytes > 0 && data.sizeBytes / data.rowCount > 1024 * 1024 && (
                        <p className="text-amber-600 dark:text-amber-400">
                          Large average row size: {formatBytes(data.sizeBytes / data.rowCount)} per row.
                        </p>
                      )}
                      {key === 'testResults' && data.rowCount > 0 && data.sizeBytes > 5 * 1024 * 1024 && (
                        <p className="text-amber-600 dark:text-amber-400">
                          A large size may mean very large JSON in test results. Browse them to check.
                        </p>
                      )}
                    </div>

                    <div className="mt-auto flex flex-wrap gap-2 border-t pt-4">
                      <Button variant="outline" className="h-11" asChild>
                        <Link href={href}>Browse</Link>
                      </Button>
                      <Button
                        variant="outline"
                        className="h-11"
                        onClick={() => previewCleanup(key)}
                        disabled={cleanupLoading}
                      >
                        <Eye aria-hidden="true" />
                        Clean up…
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          {stats.totalSizeBytes > 0 && (
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="group h-11 w-full justify-between">
                  <span>Why an empty table still has a size</span>
                  <ChevronDown className="h-4 w-4 transition-transform duration-200 group-data-[state=open]:rotate-180" aria-hidden="true" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-2 rounded-2xl border bg-card p-4 text-sm text-muted-foreground">
                  <p>PostgreSQL table sizes include:</p>
                  <ul className="mt-2 list-inside list-disc space-y-1">
                    <li>Table data (actual rows)</li>
                    <li>Indexes (for fast queries)</li>
                    <li>Table structure and metadata</li>
                    <li>Unused space from deleted rows (reused automatically)</li>
                  </ul>
                  <p className="mt-2">
                    After deleting all rows, tables still show size due to indexes and structure. This is normal
                    PostgreSQL behavior. To reclaim all space, you would need to run{' '}
                    <code className="rounded bg-muted px-1">VACUUM FULL</code> directly on the database (not
                    recommended for production).
                  </p>
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
      )}

      {/* Cleanup Options Dialog */}
      <AlertDialog open={cleanupOptionsDialogOpen} onOpenChange={setCleanupOptionsDialogOpen}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Clean up {cleanupType === 'testResults' ? 'test results' : cleanupType}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label htmlFor="cleanupStrategy">What to delete</Label>
                  <Select
                    value={cleanupOptions.strategy}
                    onValueChange={(value) => setCleanupOptions({ ...cleanupOptions, strategy: value as any })}
                  >
                    <SelectTrigger id="cleanupStrategy" className="h-11">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="deleteAll">Delete all (start fresh)</SelectItem>
                      <SelectItem value="olderThanDays">Delete older than X days</SelectItem>
                      {cleanupType === 'metrics' && <SelectItem value="maxRows">Keep last N rows per bot</SelectItem>}
                      {cleanupType === 'conversations' && (
                        <>
                          <SelectItem value="maxPerBot">Keep last N per bot</SelectItem>
                          <SelectItem value="maxTotal">Keep last N total</SelectItem>
                        </>
                      )}
                    </SelectContent>
                  </Select>
                </div>

                {cleanupOptions.strategy === 'olderThanDays' && (
                  <div className="space-y-2">
                    <Label htmlFor="olderThanDays">Days</Label>
                    <Input
                      className="h-11"
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
                    <Label htmlFor="maxPerBot">Keep the last N per bot</Label>
                    <Input
                      className="h-11"
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
                    <Label htmlFor="maxTotal">Keep the last N in total</Label>
                    <Input
                      className="h-11"
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
                    <Label htmlFor="maxRows">Keep the last N rows per bot</Label>
                    <Input
                      className="h-11"
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
                      This deletes all {cleanupType === 'testResults' ? 'test results' : cleanupType} data. It can’t be undone.
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
                  Preview cleanup
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
            <AlertDialogTitle>Cleanup preview</AlertDialogTitle>
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
                  Cleaning up…
                </>
              ) : (
                <>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
