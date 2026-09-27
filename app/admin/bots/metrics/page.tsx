'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import AuthLink from '@/app/admin/auth-link';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AlertTriangle } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyCard, Figure, Figures, LoadError, LoadingRows, PageHeader } from '../../components/ds';
import { ApplyFilter, DateFilter, FilterField, FilterRow, ListPager, Panel, Pill, type PageInfo } from '../bots-ui';

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

export default function MetricsBrowsePage() {
  const router = useRouter();
  const [responses, setResponses] = useState<GroupedResponse[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<PageInfo | null>(null);
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

  const filtered = Boolean(filters.botId || filters.timeRange !== '24h');

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        kind="bot"
        title="Metrics"
        context={<span>How bots answered: speed, quality and repetition, one row per response.</span>}
        stats={
          summary ? (
            <Figures>
              <Figure value={summary.totalResponses} label="responses" />
              <Figure value={formatMs(summary.avgResponseTime)} label="avg response time" />
              <Figure value={formatMs(summary.p95ResponseTime)} label="p95 response time" />
              <Figure value={summary.avgQuality.toFixed(3)} label="avg quality" />
              <Figure value={summary.avgRepetition.toFixed(3)} label="avg repetition" />
              <Figure value={summary.issuesDetected} label="issues detected" />
              <Figure value={summary.personalityCompliance} label="personality compliance" />
            </Figures>
          ) : undefined
        }
      />

      <FilterRow label="Filter metrics">
        <ApplyFilter
          id="botId"
          label="Bot ID"
          placeholder="Bot ID"
          value={botIdInput}
          onChange={setBotIdInput}
          onApply={() => setFilters({ ...filters, botId: botIdInput, page: 1 })}
        />
        <FilterField id="timeRange" label="Time range">
          <Select
            value={filters.timeRange}
            onValueChange={(value) => setFilters({ ...filters, timeRange: value, page: 1 })}
          >
            <SelectTrigger id="timeRange" className="h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1h">Last hour</SelectItem>
              <SelectItem value="24h">Last 24 hours</SelectItem>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
              <SelectItem value="custom">Custom range</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>
        {filters.timeRange === 'custom' && (
          <>
            <DateFilter id="startDate" label="From" value={filters.startDate} onChange={(startDate) => setFilters({ ...filters, startDate, page: 1 })} />
            <DateFilter id="endDate" label="To" value={filters.endDate} onChange={(endDate) => setFilters({ ...filters, endDate, page: 1 })} />
          </>
        )}
      </FilterRow>

      {error && <LoadError label="metrics" retry={fetchMetrics} />}

      {/* Issue Highlights */}
      {problematicResponses.length > 0 && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Issues found ({problematicResponses.length})</AlertTitle>
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

      {loading && responses.length === 0 ? (
        <LoadingRows label="metrics" rows={5} />
      ) : responses.length === 0 ? (
        !error &&
        (filtered ? (
          <p className="text-sm text-muted-foreground" role="status">
            No responses in this range.
          </p>
        ) : (
          <EmptyCard kind="bot" title="No metrics yet." text="Metrics appear here once bots start answering players." />
        ))
      ) : (
            <>
              <Panel>
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
                                  <Pill key={i} tone="bad">
                                    {issue}
                                  </Pill>
                                ))}
                              </div>
                            ) : (
                              <Pill>None</Pill>
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
                    <div key={key} className={`rounded-xl border p-4 ${hasIssues(response) ? 'border-destructive/60' : ''}`}>
                        <div className="space-y-3">
                          <div className="flex items-start justify-between">
                            <div className="space-y-1">
                              <div className="text-sm font-medium text-muted-foreground">Timestamp</div>
                              <div className="font-mono text-sm font-semibold">
                                {formatDate(response.timestamp)}
                              </div>
                            </div>
                            {issues.length > 0 && (
                              <Pill tone="bad">
                                {issues.length} Issue{issues.length > 1 ? 's' : ''}
                              </Pill>
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
                                  <Pill key={i} tone="bad">
                                    {issue}
                                  </Pill>
                                ))}
                              </div>
                            </div>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-11 w-full"
                            onClick={() => setExpandedResponse(isExpanded ? null : key)}
                          >
                            {isExpanded ? 'Hide' : 'Show'} details
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
                    </div>
                  );
                })}
              </div>
              </Panel>
              <ListPager pagination={pagination} noun={['response', 'responses']} loading={loading} onChange={handlePageChange} />
            </>
      )}
    </div>
  );
}
