'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Database, Server } from 'lucide-react';
import { Context, EmptyCard, EntityCard, LoadError, LoadingRows, PageHeader, StatLine } from '../components/ds';
import { FilterField, FilterRow, ListPager, Pill, type PageInfo } from './bots-ui';
import { useReplacePage } from '@/app/admin/orbit-frame-context';

interface Bot {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  aiProviderRef: string | null;
  createdAt: string;
  room: {
    id: string;
    name: string;
    slug: string;
    world: {
      id: string;
      name: string;
      slug: string;
      universe: {
        id: string;
        name: string;
        slug: string;
      };
    };
  };
  createdBy: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
}

export default function BotsPage() {
  const router = useRouter();
  const replacePage = useReplacePage();
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<PageInfo | null>(null);
  const [filters, setFilters] = useState({
    search: '',
    enabled: '',
    page: 1,
    limit: 20,
  });
  const [searchInput, setSearchInput] = useState('');

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (!loading) {
      // Debounce search
      const timer = setTimeout(() => {
        fetchBots();
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
        replacePage('/admin');
        return;
      }
      fetchBots();
    } catch (err) {
      router.push('/admin/login');
    }
  }

  async function fetchBots() {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      const params = new URLSearchParams();
      params.append('page', filters.page.toString());
      params.append('limit', filters.limit.toString());
      if (filters.search) params.append('search', filters.search);
      if (filters.enabled) params.append('enabled', filters.enabled);

      const response = await authenticatedFetch(`/api/admin/bots?${params.toString()}`);

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          replacePage('/admin');
          return;
        }
        throw new Error('Failed to fetch bots');
      }

      const data = await response.json();
      setBots(data.bots || []);
      setPagination(data.pagination || null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    setFilters({ ...filters, search: value, page: 1 });
  };

  const handlePageChange = (newPage: number) => {
    setFilters({ ...filters, page: newPage });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const filtered = Boolean(filters.search || filters.enabled);

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        kind="bot"
        title="Bots"
        context={<span>Every bot, in every room. Open one to manage it.</span>}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/admin/bots/database">
                <Database aria-hidden="true" />
                Bot database
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/admin/bots/mcp-servers">
                <Server aria-hidden="true" />
                MCP servers
              </Link>
            </Button>
          </>
        }
      />

      <FilterRow label="Filter bots" className="lg:grid-cols-3">
        <FilterField id="search" label="Search">
          <Input
            id="search"
            type="search"
            className="h-11"
            placeholder="Name or description"
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
        </FilterField>
        <FilterField id="enabled" label="Status">
          <Select
            value={filters.enabled || 'all'}
            onValueChange={(value) => setFilters({ ...filters, enabled: value === 'all' ? '' : value, page: 1 })}
          >
            <SelectTrigger id="enabled" className="h-11">
              <SelectValue placeholder="All bots" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All bots</SelectItem>
              <SelectItem value="true">Enabled only</SelectItem>
              <SelectItem value="false">Disabled only</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>
      </FilterRow>

      {error && <LoadError label="bots" retry={fetchBots} />}

      {loading && bots.length === 0 ? (
        <LoadingRows label="bots" rows={4} />
      ) : bots.length === 0 ? (
        !error &&
        (filtered ? (
          <p className="text-sm text-muted-foreground" role="status">
            No bots match these filters.
          </p>
        ) : (
          <EmptyCard kind="bot" title="No bots yet." text="Bots appear here once someone adds one to a room." />
        ))
      ) : (
        <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {bots.map((bot) => (
            <EntityCard
              key={bot.id}
              href={`/admin/bots/${bot.id}`}
              kind="bot"
              title={bot.name}
              context={
                <Context
                  parts={[
                    { label: bot.room.world.universe.name },
                    { label: bot.room.world.name },
                    { label: bot.room.name },
                  ]}
                />
              }
              pills={
                <>
                  <Pill tone={bot.enabled ? 'ok' : 'off'}>{bot.enabled ? 'Enabled' : 'Disabled'}</Pill>
                  {bot.aiProviderRef && <Pill>{bot.aiProviderRef}</Pill>}
                </>
              }
              description={bot.description}
              meta={
                <StatLine
                  items={[
                    bot.createdBy && `by ${bot.createdBy.name || bot.createdBy.email}`,
                    `created ${new Date(bot.createdAt).toLocaleDateString()}`,
                  ]}
                />
              }
            />
          ))}
        </div>
      )}

      <ListPager pagination={pagination} noun={['bot', 'bots']} loading={loading} onChange={handlePageChange} />
    </div>
  );
}
