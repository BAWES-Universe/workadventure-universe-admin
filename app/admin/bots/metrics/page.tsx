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
import { AlertCircle, Loader2, BarChart3, ArrowLeft, Search, Clock, TrendingUp, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface GroupedResponse {
  responseId: string | null;
  timestamp: Date | string;
  botId: string;
  metadata: any;
  metrics: {
    responseTime?: number;
    repetitionScore?: number;
    conversationQuality?: number;
    personalityCompliance?: number;
    systemPromptLeakage?: boolean;
    errorCount?: number;
    tokenUsage?: {
      prompt?: number;
      completion?: number;
      total?: number;
    };
  };
}

interface Summary {
  totalResponses: number;
  avgResponseTime: number;
  avgQuality: number;
  avgRepetition: number;
  avgCompliance: number;
  p95ResponseTime: number;
  issuesDetected: number;
  personalityCompliance: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export default function MetricsBrowsePage() {
  const router = useRouter();
  const [responses, setResponses] = useState<GroupedResponse[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [filters, setFilters] = useState({
    botId: '',
    timeRange: '24h', // '1h', '24h', '7d', '30d', 'custom'
    startDate: '',
    endDate: '',
    page: 1,
    limit: 50,
  });
  const [botIdInput, setBotIdInput] = useState('');
  const [expandedResponse, setExpandedResponse] = useState<string | null>(null);

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

  // Calculate date range based on timeRange filter
  useEffect(() => {
    if (filters.timeRange !== 'custom') {
      const now = new Date();
      let startDate = new Date();
      
      switch (filters.timeRange) {
        case '1h':
          startDate.setHours(now.getHours() - 1);
          break;
        case '24h':
          startDate.setHours(now.getHours() - 24);
          break;
        case '7d':
          startDate.setDate(now.getDate() - 7);
          break;
        case '30d':
          startDate.setDate(now.getDate() - 30);
          break;
      }
      
      setFilters(prev => ({
        ...prev,
        startDate: startDate.toISOString().split('T')[0],
        endDate: now.toISOString().split('T')[0],
      }));
    }
  }, [filters.timeRange]);

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
      setResponses(data.responses || []);
      setSummary(data.summary || null);
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
    return new Date(date).toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      second: '2-digit',
      hour12: true 
    });
  }

  function formatNumber(num: number): string {
    return new Intl.NumberFormat().format(num);
  }

  function formatMs(ms: number): string {
    return `${formatNumber(Math.round(ms))}ms`;
  }

  function hasIssues(response: GroupedResponse): boolean {
    const m = response.metrics;
    return (
      (m.repetitionScore || 0) > 0.2 ||
      (m.conversationQuality || 1) < 0.8 ||
      m.systemPromptLeakage === true ||
      (m.errorCount || 0) > 0
    );
  }

  function getIssueBadges(response: GroupedResponse): string[] {
    const issues: string[] = [];
    const m = response.metrics;
    if ((m.repetitionScore || 0) > 0.2) issues.push('High Repetition');
    if ((m.conversationQuality || 1) < 0.8) issues.push('Low Quality');
    if (m.systemPromptLeakage === true) issues.push('Prompt Leakage');
    if ((m.errorCount || 0) > 0) issues.push('Errors');
    return issues;
  }

  const problematicResponses = responses.filter(hasIssues);

  if (loading && responses.length === 0) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-4xl font-bold tracking-tight">Response Metrics</h1>
            <p className="text-muted-foreground text-lg">
              View bot performance metrics grouped by response
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-6">
                <div className="h-20 bg-muted animate-pulse rounded" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" asChild>
            <AuthLink href="/admin/bots/database">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </AuthLink>
          </Button>
          <div className="space-y-1">
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight">Response Metrics</h1>
            <p className="text-muted-foreground text-sm md:text-lg">
              Bot performance metrics grouped by response
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
              <Label htmlFor="timeRange">Time Range</Label>
              <Select
                value={filters.timeRange}
                onValueChange={(value) => setFilters({ ...filters, timeRange: value, page: 1 })}
              >
                <SelectTrigger id="timeRange">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1h">Last Hour</SelectItem>
                  <SelectItem value="24h">Last 24 Hours</SelectItem>
                  <SelectItem value="7d">Last 7 Days</SelectItem>
                  <SelectItem value="30d">Last 30 Days</SelectItem>
                  <SelectItem value="custom">Custom Range</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {filters.timeRange === 'custom' && (
              <>
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
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          <Card>
            <CardContent className="pt-6">
              <div className="text-sm font-medium text-muted-foreground mb-1">Avg Response Time</div>
              <div className="text-2xl font-bold">{formatMs(summary.avgResponseTime)}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {summary.totalResponses} responses
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-sm font-medium text-muted-foreground mb-1">Avg Quality</div>
              <div className="text-2xl font-bold">{summary.avgQuality.toFixed(3)}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {summary.totalResponses} responses
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-sm font-medium text-muted-foreground mb-1">Avg Repetition</div>
              <div className="text-2xl font-bold">{summary.avgRepetition.toFixed(3)}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {summary.totalResponses} responses
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-sm font-medium text-muted-foreground mb-1">P95 Response Time</div>
              <div className="text-2xl font-bold">{formatMs(summary.p95ResponseTime)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-sm font-medium text-muted-foreground mb-1">Issues Detected</div>
              <div className="text-2xl font-bold">{summary.issuesDetected}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-sm font-medium text-muted-foreground mb-1">Personality</div>
              <div className="text-2xl font-bold">{summary.personalityCompliance}</div>
              <div className="text-xs text-muted-foreground mt-1">
                Compliance
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Issue Highlights */}
      {problematicResponses.length > 0 && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Issues Found ({problematicResponses.length})</AlertTitle>
          <AlertDescription>
            {problematicResponses.slice(0, 3).map((r, i) => {
              const issues = getIssueBadges(r);
              return (
                <div key={i} className="mt-2 text-sm">
                  Response at {formatDate(r.timestamp)}: {issues.join(', ')}
                </div>
              );
            })}
            {problematicResponses.length > 3 && (
              <div className="mt-2 text-sm text-muted-foreground">
                ...and {problematicResponses.length - 3} more
              </div>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Responses Table */}
      <Card>
        <CardHeader>
          <CardTitle>Response Metrics</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {responses.length === 0 ? (
            <div className="py-12 text-center">
              <BarChart3 className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
              <h3 className="text-lg font-semibold mb-2">No responses found</h3>
              <p className="text-sm text-muted-foreground">
                {filters.botId || filters.startDate
                  ? 'Try adjusting your filters to see more results.'
                  : 'No metrics have been recorded yet.'}
              </p>
            </div>
          ) : (
            <>
              {/* Desktop Table View */}
              <div className="hidden md:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Timestamp</TableHead>
                      <TableHead>Response Time</TableHead>
                      <TableHead>Quality</TableHead>
                      <TableHead>Repetition</TableHead>
                      <TableHead>Compliance</TableHead>
                      <TableHead>Leakage</TableHead>
                      <TableHead>Issues</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {responses.map((response, idx) => {
                      const key = response.responseId || `response_${idx}_${response.timestamp}`;
                      const m = response.metrics;
                      const issues = getIssueBadges(response);
                      const isExpanded = expandedResponse === key;
                      
                      return (
                        <TableRow key={key} className={hasIssues(response) ? 'bg-destructive/5' : ''}>
                          <TableCell className="font-mono text-sm">
                            {formatDate(response.timestamp)}
                          </TableCell>
                          <TableCell>
                            {m.responseTime ? formatMs(m.responseTime) : '—'}
                          </TableCell>
                          <TableCell>
                            {m.conversationQuality !== undefined 
                              ? m.conversationQuality.toFixed(3) 
                              : '—'}
                          </TableCell>
                          <TableCell>
                            {m.repetitionScore !== undefined 
                              ? m.repetitionScore.toFixed(3) 
                              : '—'}
                          </TableCell>
                          <TableCell>
                            {m.personalityCompliance !== undefined 
                              ? m.personalityCompliance.toFixed(2) 
                              : '—'}
                          </TableCell>
                          <TableCell>
                            {m.systemPromptLeakage !== undefined 
                              ? (m.systemPromptLeakage ? 'Yes' : 'No') 
                              : '—'}
                          </TableCell>
                          <TableCell>
                            {issues.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {issues.map((issue, i) => (
                                  <Badge key={i} variant="destructive" className="text-xs">
                                    {issue}
                                  </Badge>
                                ))}
                              </div>
                            ) : (
                              <Badge variant="outline" className="text-xs">None</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile Card View */}
              <div className="md:hidden space-y-4 p-4">
                {responses.map((response, idx) => {
                  const key = response.responseId || `response_${idx}_${response.timestamp}`;
                  const m = response.metrics;
                  const issues = getIssueBadges(response);
                  const isExpanded = expandedResponse === key;
                  
                  return (
                    <Card key={key} className={hasIssues(response) ? 'border-destructive' : ''}>
                      <CardContent className="pt-6">
                        <div className="space-y-3">
                          <div className="flex items-start justify-between">
                            <div className="space-y-1">
                              <div className="text-sm font-medium text-muted-foreground">Timestamp</div>
                              <div className="font-mono text-sm font-semibold">
                                {formatDate(response.timestamp)}
                              </div>
                            </div>
                            {issues.length > 0 && (
                              <Badge variant="destructive" className="text-xs">
                                {issues.length} Issue{issues.length > 1 ? 's' : ''}
                              </Badge>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <div className="text-xs text-muted-foreground mb-1">Response Time</div>
                              <div className="text-sm font-semibold">
                                {m.responseTime ? formatMs(m.responseTime) : '—'}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-muted-foreground mb-1">Quality</div>
                              <div className="text-sm font-semibold">
                                {m.conversationQuality !== undefined 
                                  ? m.conversationQuality.toFixed(3) 
                                  : '—'}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-muted-foreground mb-1">Repetition</div>
                              <div className="text-sm font-semibold">
                                {m.repetitionScore !== undefined 
                                  ? m.repetitionScore.toFixed(3) 
                                  : '—'}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-muted-foreground mb-1">Compliance</div>
                              <div className="text-sm font-semibold">
                                {m.personalityCompliance !== undefined 
                                  ? m.personalityCompliance.toFixed(2) 
                                  : '—'}
                              </div>
                            </div>
                          </div>
                          {issues.length > 0 && (
                            <div>
                              <div className="text-xs text-muted-foreground mb-1">Issues</div>
                              <div className="flex flex-wrap gap-1">
                                {issues.map((issue, i) => (
                                  <Badge key={i} variant="destructive" className="text-xs">
                                    {issue}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full"
                            onClick={() => setExpandedResponse(isExpanded ? null : key)}
                          >
                            {isExpanded ? 'Hide' : 'Show'} Details
                          </Button>
                          {isExpanded && (
                            <div className="space-y-2 pt-2 border-t">
                              <div>
                                <div className="text-xs text-muted-foreground mb-1">Bot ID</div>
                                <AuthLink
                                  href={`/admin/bots/${response.botId}`}
                                  className="text-primary hover:underline font-mono text-xs"
                                >
                                  {response.botId}
                                </AuthLink>
                              </div>
                              {response.metadata && (
                                <div>
                                  <div className="text-xs text-muted-foreground mb-1">Metadata</div>
                                  <pre className="text-xs bg-muted p-2 rounded overflow-auto">
                                    {JSON.stringify(response.metadata, null, 2)}
                                  </pre>
                                </div>
                              )}
                              {m.tokenUsage && (
                                <div>
                                  <div className="text-xs text-muted-foreground mb-1">Token Usage</div>
                                  <div className="text-xs">
                                    Prompt: {m.tokenUsage.prompt || 0}, 
                                    Completion: {m.tokenUsage.completion || 0}, 
                                    Total: {m.tokenUsage.total || 0}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              {/* Pagination */}
              {pagination && pagination.totalPages > 1 && (
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 border-t">
                  <div className="text-sm text-muted-foreground">
                    Showing {((pagination.page - 1) * pagination.limit) + 1} - {Math.min(pagination.page * pagination.limit, pagination.total)} of {formatNumber(pagination.total)} responses
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
