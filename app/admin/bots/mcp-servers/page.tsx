'use client';

import { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search } from 'lucide-react';
import { EmptyCard, EntityRow, LoadError, LoadingRows, PageHeader, StatLine } from '../../components/ds';
import { FilterField, FilterRow, ListPager, Pill, type PageInfo } from '../bots-ui';
import { useReplacePage } from '@/app/admin/orbit-frame-context';

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

export default function McpServersPage() {
  const replacePage = useReplacePage();
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<PageInfo | null>(null);
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
          replacePage('/admin');
          return;
        }
        throw new Error('Failed to fetch MCP servers');
      }

      const data = await response.json();
      setServers(data.servers || []);
      setPagination(data);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [filters, replacePage]);

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

  const filtered = Boolean(filters.search || filters.enabled);

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        kind="bot"
        title="MCP servers"
        context={
          <span>
            An MCP (Model Context Protocol) server gives a bot extra tools. These are every bot’s servers; open one to
            manage them.
          </span>
        }
      />

      <FilterRow label="Filter MCP servers" className="lg:grid-cols-3">
        <FilterField id="mcpSearch" label="Search">
          <div className="flex gap-2">
            <Input
              id="mcpSearch"
              type="search"
              className="h-11"
              placeholder="Server name, URL or bot"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            />
            <Button type="button" variant="outline" className="h-11 w-11 shrink-0 px-0" aria-label="Search" onClick={handleSearch}>
              <Search className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </FilterField>
        <FilterField id="mcpEnabled" label="Status">
          <Select
            value={filters.enabled || 'all'}
            onValueChange={(value) => setFilters((prev) => ({ ...prev, enabled: value === 'all' ? '' : value, page: 1 }))}
          >
            <SelectTrigger id="mcpEnabled" className="h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="true">Enabled</SelectItem>
              <SelectItem value="false">Disabled</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>
      </FilterRow>

      {error && <LoadError label="MCP servers" retry={() => fetchServers()} />}

      {loading && servers.length === 0 ? (
        <LoadingRows label="MCP servers" rows={4} />
      ) : servers.length === 0 ? (
        !error &&
        (filtered ? (
          <p className="text-sm text-muted-foreground" role="status">
            No MCP servers match these filters.
          </p>
        ) : (
          <EmptyCard kind="bot" title="No MCP servers yet." text="Add one from a bot’s page to give it extra tools." />
        ))
      ) : (
        <div className="grid min-w-0 gap-0.5">
          {servers.map((server) => (
            <EntityRow
              key={server.id}
              href={`/admin/bots/${server.botId}/mcp-servers`}
              kind="bot"
              title={server.name}
              context={<span className="text-sm text-muted-foreground">For {server.botName}</span>}
              meta={
                <StatLine
                  items={[
                    server.serverUrl,
                    server.authType === 'none' ? 'no auth' : server.authType,
                    `owner ${server.botOwner?.name || server.botOwner?.email || 'unknown'}`,
                    `added ${new Date(server.createdAt).toLocaleDateString()}`,
                  ]}
                />
              }
              aside={<Pill tone={server.enabled ? 'ok' : 'off'}>{server.enabled ? 'Enabled' : 'Disabled'}</Pill>}
            />
          ))}
        </div>
      )}

      <ListPager pagination={pagination} noun={['server', 'servers']} loading={loading} onChange={handlePageChange} />
    </div>
  );
}
