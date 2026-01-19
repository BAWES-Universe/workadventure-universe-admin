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
import { AlertCircle, Loader2, Activity, ArrowLeft, Search, CheckCircle2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface TestResult {
  id: number;
  testId: string;
  botId: string | null;
  testSuite: string | null;
  results: any;
  passed: boolean;
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
      <TableCell><div className="h-4 w-32 bg-muted animate-pulse rounded" /></TableCell>
      <TableCell><div className="h-4 w-24 bg-muted animate-pulse rounded" /></TableCell>
      <TableCell><div className="h-4 w-20 bg-muted animate-pulse rounded" /></TableCell>
      <TableCell><div className="h-4 w-16 bg-muted animate-pulse rounded" /></TableCell>
      <TableCell><div className="h-4 w-40 bg-muted animate-pulse rounded" /></TableCell>
      <TableCell><div className="h-4 w-32 bg-muted animate-pulse rounded" /></TableCell>
    </TableRow>
  );
}

export default function TestResultsBrowsePage() {
  const router = useRouter();
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
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

  function formatNumber(num: number): string {
    return new Intl.NumberFormat().format(num);
  }

  // Get unique test suites for filter
  const testSuites = Array.from(new Set(testResults.map(t => t.testSuite).filter(Boolean))).sort();

  if (loading && testResults.length === 0) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-4xl font-bold tracking-tight">Browse Test Results</h1>
            <p className="text-muted-foreground text-lg">
              View and filter all bot test results
            </p>
          </div>
        </div>
        <Card>
          <CardContent className="p-0">
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
            <h1 className="text-4xl font-bold tracking-tight">Browse Test Results</h1>
            <p className="text-muted-foreground text-lg">
              View and filter all bot test results
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
              onClick={fetchTestResults}
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
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-5">
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
              <Label htmlFor="testSuite">Test Suite</Label>
              <Select
                value={filters.testSuite}
                onValueChange={(value) => setFilters({ ...filters, testSuite: value === 'all' ? '' : value, page: 1 })}
              >
                <SelectTrigger id="testSuite">
                  <SelectValue placeholder="All suites" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All suites</SelectItem>
                  {testSuites.map((suite) => (
                    <SelectItem key={suite} value={suite}>{suite}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="passed">Status</Label>
              <Select
                value={filters.passed}
                onValueChange={(value) => setFilters({ ...filters, passed: value === 'all' ? '' : value, page: 1 })}
              >
                <SelectTrigger id="passed">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="true">Passed</SelectItem>
                  <SelectItem value="false">Failed</SelectItem>
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

      {/* Test Results Table */}
      <Card>
        <CardHeader>
          <CardTitle>Test Results</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {testResults.length === 0 ? (
            <div className="py-12 text-center">
              <Activity className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
              <h3 className="text-lg font-semibold mb-2">No test results found</h3>
              <p className="text-sm text-muted-foreground">
                {Object.values(filters).some(v => v && v !== '1' && v !== '50')
                  ? 'Try adjusting your filters to see more results.'
                  : 'No test results have been recorded yet.'}
              </p>
            </div>
          ) : (
            <>
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
                            <Badge variant="outline">{result.testSuite}</Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {result.passed ? (
                            <Badge variant="default" className="bg-green-600">
                              <CheckCircle2 className="mr-1 h-3 w-3" />
                              Passed
                            </Badge>
                          ) : (
                            <Badge variant="destructive">
                              <XCircle className="mr-1 h-3 w-3" />
                              Failed
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>{formatDate(result.createdAt)}</TableCell>
                        <TableCell>
                          <details className="cursor-pointer">
                            <summary className="text-sm text-muted-foreground">View</summary>
                            <pre className="mt-2 text-xs bg-muted p-2 rounded overflow-auto max-w-md">
                              {JSON.stringify(result.results, null, 2)}
                            </pre>
                          </details>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile Card View */}
              <div className="md:hidden space-y-4 p-4">
                {testResults.map((result) => (
                  <Card key={result.id}>
                    <CardContent className="pt-6">
                      <div className="space-y-3">
                        <div className="flex items-start justify-between">
                          <div className="space-y-1 flex-1 min-w-0">
                            <div className="text-sm font-medium text-muted-foreground">Test ID</div>
                            <div className="font-mono text-sm font-semibold truncate">{result.testId}</div>
                          </div>
                          {result.passed ? (
                            <Badge variant="default" className="bg-green-600">
                              <CheckCircle2 className="mr-1 h-3 w-3" />
                              Passed
                            </Badge>
                          ) : (
                            <Badge variant="destructive">
                              <XCircle className="mr-1 h-3 w-3" />
                              Failed
                            </Badge>
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
                            <Badge variant="outline">{result.testSuite}</Badge>
                          </div>
                        )}
                        <div>
                          <div className="text-sm font-medium text-muted-foreground mb-1">Created</div>
                          <div className="text-sm">{formatDate(result.createdAt)}</div>
                        </div>
                        <div>
                          <details className="cursor-pointer">
                            <summary className="text-sm font-medium text-muted-foreground">View Results</summary>
                            <pre className="mt-2 text-xs bg-muted p-2 rounded overflow-auto">
                              {JSON.stringify(result.results, null, 2)}
                            </pre>
                          </details>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Pagination */}
              {pagination && pagination.totalPages > 1 && (
                <div className="flex items-center justify-between p-4 border-t">
                  <div className="text-sm text-muted-foreground">
                    Showing {((pagination.page - 1) * pagination.limit) + 1} - {Math.min(pagination.page * pagination.limit, pagination.total)} of {formatNumber(pagination.total)} results
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
