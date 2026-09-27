'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import AuthLink from '@/app/admin/auth-link';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyCard, LoadError, LoadingRows, PageHeader } from '../../components/ds';
import { ApplyFilter, DateFilter, FilterField, FilterRow, JsonDetails, ListPager, Panel, Pill, type PageInfo } from '../bots-ui';

interface TestResult {
  id: number;
  testId: string;
  botId: string | null;
  testSuite: string | null;
  results: any;
  passed: boolean;
  createdAt: Date;
}

export default function TestResultsBrowsePage() {
  const router = useRouter();
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<PageInfo | null>(null);
  const [filters, setFilters] = useState({
    botId: '',
    testSuite: '',
    passed: '',
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
        fetchTestResults();
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
      fetchTestResults();
    } catch (err) {
      router.push('/admin/login');
    }
  }

  const fetchTestResults = useCallback(async () => {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      const params = new URLSearchParams();
      params.append('page', filters.page.toString());
      params.append('limit', filters.limit.toString());
      if (filters.botId) params.append('botId', filters.botId);
      if (filters.testSuite) params.append('testSuite', filters.testSuite);
      if (filters.passed) params.append('passed', filters.passed);
      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);

      const response = await authenticatedFetch(`/api/admin/bots/test-results?${params.toString()}`);

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          router.push('/admin');
          return;
        }
        throw new Error('Failed to fetch test results');
      }

      const data = await response.json();
      setTestResults(data.testResults || []);
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


  // Get unique test suites for filter (exclude null/undefined so SelectItem value is string)
  const testSuites = Array.from(new Set(testResults.map(t => t.testSuite).filter((s): s is string => s != null))).sort();

  const filtered = Boolean(filters.botId || filters.testSuite || filters.passed || filters.startDate || filters.endDate);

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        kind="bot"
        title="Test results"
        context={<span>Automated checks run against bots, newest first.</span>}
      />

      <FilterRow label="Filter test results" className="lg:grid-cols-5">
        <ApplyFilter
          id="botId"
          label="Bot ID"
          placeholder="Bot ID"
          value={botIdInput}
          onChange={setBotIdInput}
          onApply={() => setFilters({ ...filters, botId: botIdInput, page: 1 })}
        />
        <FilterField id="testSuite" label="Test suite">
          <Select
            value={filters.testSuite}
            onValueChange={(value) => setFilters({ ...filters, testSuite: value === 'all' ? '' : value, page: 1 })}
          >
            <SelectTrigger id="testSuite" className="h-11">
              <SelectValue placeholder="All suites" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All suites</SelectItem>
              {testSuites.map((suite) => (
                <SelectItem key={suite} value={suite}>{suite}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>
        <FilterField id="passed" label="Status">
          <Select
            value={filters.passed}
            onValueChange={(value) => setFilters({ ...filters, passed: value === 'all' ? '' : value, page: 1 })}
          >
            <SelectTrigger id="passed" className="h-11">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="true">Passed</SelectItem>
              <SelectItem value="false">Failed</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>
        <DateFilter id="startDate" label="From" value={filters.startDate} onChange={(startDate) => setFilters({ ...filters, startDate, page: 1 })} />
        <DateFilter id="endDate" label="To" value={filters.endDate} onChange={(endDate) => setFilters({ ...filters, endDate, page: 1 })} />
      </FilterRow>

      {error && <LoadError label="test results" retry={fetchTestResults} />}

      {loading && testResults.length === 0 ? (
        <LoadingRows label="test results" rows={5} />
      ) : testResults.length === 0 ? (
        !error &&
        (filtered ? (
          <p className="text-sm text-muted-foreground" role="status">
            No test results match these filters.
          </p>
        ) : (
          <EmptyCard kind="bot" title="No test results yet." text="Results appear here once bot tests have run." />
        ))
      ) : (
            <>
              <Panel>
              {/* Desktop Table View */}
              <div className="hidden md:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Test ID</TableHead>
                      <TableHead>Bot ID</TableHead>
                      <TableHead>Test Suite</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Results</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {testResults.map((result) => (
                      <TableRow key={result.id}>
                        <TableCell className="font-mono text-sm">{result.testId}</TableCell>
                        <TableCell>
                          {result.botId ? (
                            <AuthLink
                              href={`/admin/bots/${result.botId}`}
                              className="text-primary hover:underline font-mono text-sm"
                            >
                              {result.botId}
                            </AuthLink>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {result.testSuite ? (
                            <Pill>{result.testSuite}</Pill>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {result.passed ? (
                            <Pill tone="ok">Passed</Pill>
                          ) : (
                            <Pill tone="bad">Failed</Pill>
                          )}
                        </TableCell>
                        <TableCell>{formatDate(result.createdAt)}</TableCell>
                        <TableCell>
                          <JsonDetails label="View" value={result.results} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile Card View */}
              <div className="md:hidden space-y-4 p-4">
                {testResults.map((result) => (
                  <div key={result.id} className="rounded-xl border p-4">
                    <div>
                      <div className="space-y-3">
                        <div className="flex items-start justify-between">
                          <div className="space-y-1 flex-1 min-w-0">
                            <div className="text-sm font-medium text-muted-foreground">Test ID</div>
                            <div className="font-mono text-sm font-semibold truncate">{result.testId}</div>
                          </div>
                          {result.passed ? (
                            <Pill tone="ok">Passed</Pill>
                          ) : (
                            <Pill tone="bad">Failed</Pill>
                          )}
                        </div>
                        {result.botId && (
                          <div>
                            <div className="text-sm font-medium text-muted-foreground mb-1">Bot ID</div>
                            <AuthLink
                              href={`/admin/bots/${result.botId}`}
                              className="text-primary hover:underline font-mono text-sm font-semibold"
                            >
                              {result.botId}
                            </AuthLink>
                          </div>
                        )}
                        {result.testSuite && (
                          <div>
                            <div className="text-sm font-medium text-muted-foreground mb-1">Test Suite</div>
                            <Pill>{result.testSuite}</Pill>
                          </div>
                        )}
                        <div>
                          <div className="text-sm font-medium text-muted-foreground mb-1">Created</div>
                          <div className="text-sm">{formatDate(result.createdAt)}</div>
                        </div>
                        <div>
                          <JsonDetails label="View results" value={result.results} />
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              </Panel>
              <ListPager pagination={pagination} noun={['result', 'results']} loading={loading} onChange={handlePageChange} />
            </>
      )}
    </div>
  );
}
