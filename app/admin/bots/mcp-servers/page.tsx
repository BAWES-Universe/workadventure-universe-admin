'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import AuthLink from '@/app/admin/auth-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { AlertCircle, Loader2, Server, Search, Wifi, WifiOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface McpServerEntry {
  id: string;
  botId: string;
  botName: string;
  name: string;
  serverUrl: string;
  authType: string;
  enabled: boolean;
  createdAt: string;
  botOwner: { name: string | null; email: string | null } | null;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export default function McpServersPage() {
  const router = useRouter();
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [filters, setFilters] = useState({ search: '', enabled: '', page: 1, limit: 20 });
  const [searchInput, setSearchInput] = useState('');

  const fetchServers = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams();
      params.append('page', filters.page.toString());
      params.append('limit', filters.limit.toString());
      if (filters.search) params.append('search', filters.search);
      if (filters.enabled) params.append('enabled', filters.enabled);

      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/mcp-servers?${params.toString()}`, {
        signal,
      });

      if (!response.ok) {
        if (response.status === 403) {
          router.push('/admin');
          return;
        }
        throw new Error('Failed to fetch MCP servers');
      }

      const data = await response.json();
      setServers(data.servers || []);
      setPagination(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [filters, router]);

  useEffect(() => {
    const abortController = new AbortController();
    const timer = setTimeout(() => {
      fetchServers(abortController.signal);
    }, 300);
    return () => {
      clearTimeout(timer);
      abortController.abort();
    };
  }, [fetchServers]);

  function handleSearch() {
    setFilters((prev) => ({ ...prev, search: searchInput, page: 1 }));
  }

  function handlePageChange(newPage: number) {
    setFilters((prev) => ({ ...prev, page: newPage }));
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">MCP Servers</h1>
          <p className="text-muted-foreground text-sm">
            View all MCP servers across all bots
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by server name, URL, or bot..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="pl-8"
          />
        </div>
        <Button variant="secondary" onClick={handleSearch}>Search</Button>
        <select
          value={filters.enabled}
          onChange={(e) => setFilters((prev) => ({ ...prev, enabled: e.target.value, page: 1 }))}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
        >
          <option value="">All Status</option>
          <option value="true">Enabled</option>
          <option value="false">Disabled</option>
        </select>
      </div>

      {/* Error */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center min-h-[200px]">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      )}

      {/* Empty */}
      {!loading && !error && servers.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Server className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground text-lg font-medium mb-1">No MCP servers found</p>
            <p className="text-muted-foreground text-sm">
              {filters.search ? 'Try adjusting your search filters.' : 'No MCP servers have been configured yet.'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Table */}
      {!loading && !error && servers.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <table className="w-full">
              <thead>
                <tr className="border-b">
                  <th className="text-left px-4 py-3 text-sm font-medium text-muted-foreground">Server Name</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-muted-foreground">Bot</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-muted-foreground">URL</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-muted-foreground">Auth</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-muted-foreground">Status</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-muted-foreground">Owner</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-muted-foreground">Created</th>
                </tr>
              </thead>
              <tbody>
                {servers.map((server) => (
                  <tr key={server.id} className="border-b last:border-b-0 hover:bg-muted/50 transition-colors">
                    <td className="px-4 py-3 font-medium">{server.name}</td>
                    <td className="px-4 py-3">
                      <AuthLink
                        href={`/admin/bots/${server.botId}`}
                        className="text-blue-500 hover:underline"
                      >
                        {server.botName}
                      </AuthLink>
                    </td>
                    <td className="px-4 py-3 max-w-[200px] truncate text-sm text-muted-foreground">
                      {server.serverUrl}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={server.authType === 'none' ? 'secondary' : 'outline'}>
                        {server.authType}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      {server.enabled ? (
                        <span className="flex items-center gap-1 text-green-600 text-sm">
                          <Wifi className="h-3 w-3" /> Enabled
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-muted-foreground text-sm">
                          <WifiOff className="h-3 w-3" /> Disabled
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {server.botOwner?.name || server.botOwner?.email || 'Unknown'}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {new Date(server.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {((pagination.page - 1) * pagination.limit) + 1} - {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total} servers
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => handlePageChange(pagination.page - 1)}
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">Page {pagination.page} of {pagination.totalPages}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => handlePageChange(pagination.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
