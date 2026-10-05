'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EntityRow, Figure, Figures, LoadError, LoadingRows, PageHeader, SectionHeader, StatLine, count } from '../../components/ds';
import { providerTypeLabel } from '../components/provider-state';
import { useReplacePage } from '@/app/admin/orbit-frame-context';

interface UsageStats {
  totalCalls: number;
  totalTokens: number;
  totalCost: number;
  totalDuration: number;
  errorCount: number;
  byProvider: Record<string, {
    providerId: string;
    providerName: string;
    providerType: string;
    calls: number;
    tokens: number;
    cost: number;
    duration: number;
    errors: number;
  }>;
  byBot: Record<string, {
    botId: string;
    botName: string;
    calls: number;
    tokens: number;
    cost: number;
    duration: number;
    errors: number;
  }>;
}

export default function AiUsagePage() {
  const router = useRouter();
  const replacePage = useReplacePage();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [totalEntries, setTotalEntries] = useState(0);

  const [filters, setFilters] = useState({
    startDate: '',
    endDate: '',
    providerId: '',
    botId: '',
  });

  useEffect(() => {
    checkAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loading) {
      fetchUsage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      fetchUsage();
    } catch {
      router.push('/admin/login');
    }
  }

  async function fetchUsage() {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      const params = new URLSearchParams();
      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);
      if (filters.providerId) params.append('providerId', filters.providerId);
      if (filters.botId) params.append('botId', filters.botId);

      const response = await authenticatedFetch(`/api/admin/ai-providers/usage?${params.toString()}`);

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          replacePage('/admin');
          return;
        }
        throw new Error('Failed to fetch usage data');
      }

      const data = await response.json();
      setStats(data.stats);
      setTotalEntries(data.totalEntries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  function formatNumber(num: number): string {
    return new Intl.NumberFormat().format(num);
  }

  function formatCurrency(amount: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount);
  }

  function formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  const idFiltered = Boolean(filters.providerId || filters.botId);
  const providers = stats ? Object.values(stats.byProvider) : [];
  const bots = stats ? Object.entries(stats.byBot).sort((a, b) => b[1].calls - a[1].calls) : [];

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        kind="provider"
        title="AI usage"
        context={<span className="text-sm text-muted-foreground">Calls, tokens and cost across AI providers and bots.</span>}
        stats={
          stats && (
            <Figures>
              <Figure value={formatNumber(stats.totalCalls)} label="calls" />
              <Figure value={formatNumber(stats.totalTokens)} label="tokens" />
              <Figure value={formatCurrency(stats.totalCost)} label="cost" />
              <Figure value={formatDuration(stats.totalDuration)} label="duration" />
              <Figure
                value={formatNumber(stats.errorCount)}
                label={
                  stats.totalCalls > 0
                    ? `errors (${((stats.errorCount / stats.totalCalls) * 100).toFixed(2)}%)`
                    : 'errors'
                }
              />
            </Figures>
          )
        }
      />

      <section aria-labelledby="usage-filters" className="min-w-0 rounded-2xl border bg-card p-4 sm:p-5">
        <h2 id="usage-filters" className="sr-only">
          Filters
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="startDate">From</Label>
            <Input
              id="startDate"
              type="date"
              className="h-11"
              value={filters.startDate}
              onChange={(e) => setFilters({ ...filters, startDate: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="endDate">To</Label>
            <Input
              id="endDate"
              type="date"
              className="h-11"
              value={filters.endDate}
              onChange={(e) => setFilters({ ...filters, endDate: e.target.value })}
            />
          </div>
        </div>
        <details className="group mt-4" open={idFiltered || undefined}>
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold [&::-webkit-details-marker]:hidden">
            <ChevronRight size={16} className="text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
            Advanced
            {idFiltered && <span className="text-xs font-normal text-muted-foreground">(filtered)</span>}
          </summary>
          <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="providerId">Provider key</Label>
              <Input
                id="providerId"
                className="h-11 font-mono"
                value={filters.providerId}
                onChange={(e) => setFilters({ ...filters, providerId: e.target.value })}
                placeholder="Filter by provider"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="botId">Bot ID</Label>
              <Input
                id="botId"
                className="h-11 font-mono"
                value={filters.botId}
                onChange={(e) => setFilters({ ...filters, botId: e.target.value })}
                placeholder="Filter by bot"
              />
            </div>
          </div>
        </details>
      </section>

      {error && <LoadError label="AI usage" retry={fetchUsage} />}

      {loading && !stats ? (
        <LoadingRows label="AI usage" rows={4} />
      ) : (
        stats && (
          <>
            <section aria-labelledby="usage-providers" className="min-w-0">
              <SectionHeader id="usage-providers" title="By provider" count={providers.length} />
              {providers.length === 0 ? (
                <p className="text-sm text-muted-foreground">No provider usage in this range.</p>
              ) : (
                <div className="grid min-w-0 gap-0.5">
                  {providers.map((provider) => (
                    <EntityRow
                      key={provider.providerId}
                      href={`/admin/ai-providers/${provider.providerId}`}
                      kind="provider"
                      title={provider.providerName}
                      context={
                        <StatLine
                          items={[
                            count(provider.calls, 'call'),
                            count(provider.tokens, 'token'),
                            formatCurrency(provider.cost),
                            provider.errors > 0 && count(provider.errors, 'error'),
                          ]}
                        />
                      }
                      meta={<StatLine items={[providerTypeLabel(provider.providerType), provider.providerId]} />}
                    />
                  ))}
                </div>
              )}
            </section>

            <section aria-labelledby="usage-bots" className="min-w-0">
              <SectionHeader id="usage-bots" title="By bot" count={bots.length} />
              {bots.length === 0 ? (
                <p className="text-sm text-muted-foreground">No bot usage in this range.</p>
              ) : (
                <div className="grid min-w-0 gap-0.5">
                  {bots.map(([botId, bot]) => (
                    <EntityRow
                      key={botId}
                      href={`/admin/bots/${botId}`}
                      kind="bot"
                      title={bot.botName}
                      context={
                        <StatLine
                          items={[
                            count(bot.calls, 'call'),
                            count(bot.tokens, 'token'),
                            formatCurrency(bot.cost),
                            bot.errors > 0 && count(bot.errors, 'error'),
                          ]}
                        />
                      }
                      meta={<span className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{botId}</span>}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )
      )}

      {totalEntries > 0 && (
        <p className="text-center text-sm text-muted-foreground">Based on {count(totalEntries, 'usage entry', 'usage entries')}</p>
      )}
    </div>
  );
}
