'use client';

import { useState, useEffect, useCallback, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AlertCircle, ChevronDown, Server } from 'lucide-react';
import BotTexturePicker from '@/components/bot-texture-picker';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  EmptyCard,
  EntityRow,
  Figure,
  Figures,
  InContext,
  LoadError,
  LoadingRows,
  PageHeader,
  SectionHeader,
  StatLine,
  count,
} from '../../components/ds';
import { Pager } from '../../discover/discover-ui';
import { DateFilter, Detail, FilterRow, Panel, Pill } from '../bots-ui';
import { useReplacePage } from '@/app/admin/orbit-frame-context';

interface Bot {
  id: string;
  name: string;
  description: string | null;
  characterTextureId: string | null;
  enabled: boolean;
  behaviorType: string;
  behaviorConfig: any;
  chatInstructions: string | null;
  movementInstructions: string | null;
  aiProviderRef: string | null;
  createdAt: string;
  updatedAt: string;
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
  updatedBy: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
}

interface UsageEntry {
  id: number;
  botId: string;
  providerId: string;
  tokensUsed: number;
  apiCalls: number;
  durationSeconds: number | null;
  cost: number | null;
  latency: number | null;
  error: boolean;
  timestamp: string;
  provider: {
    providerId: string;
    name: string;
    type: string;
  };
}

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
}

interface MetricData {
  botId: string;
  timestamp: number;
  metrics: {
    responseTime?: number;
    tokenUsage?: {
      prompt?: number;
      completion?: number;
      total?: number;
    };
    repetitionScore?: number;
    systemPromptLeakage?: boolean;
    personalityCompliance?: number;
    conversationQuality?: number;
    errorCount?: number;
  };
  metadata?: Record<string, any>;
}

interface Conversation {
  id: number;
  botId: string;
  userUuid: string | null;
  userId: string | null;
  userName: string | null;
  isGuest: boolean;
  user?: {
    id: string;
    email: string | null;
    name: string | null;
    uuid: string;
  } | null;
  messages: Array<{
    sender: string;
    message: string;
    timestamp: number;
  }>;
  startedAt: string;
  endedAt: string;
  endReason?: string | null;
  messageCount: number;
  createdAt: string;
}

interface ConversationStats {
  botId: string;
  totalConversations: number;
  oldestConversation: number;
  newestConversation: number;
  totalSize: number;
}

interface EmotionData {
  userUuid: string;
  userId: string | null;
  userName: string | null;
  isGuest: boolean;
  user?: {
    id: string;
    email: string | null;
    name: string | null;
    uuid: string;
  } | null;
  emotions: {
    botEmotion?: Record<string, number>;
    personEmotion?: Record<string, number>;
  };
  lastEmotionUpdate: number | null;
}

export default function BotDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const replacePage = useReplacePage();
  const [botId, setBotId] = useState<string>('');
  
  const [bot, setBot] = useState<Bot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageEntry[]>([]);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [totalEntries, setTotalEntries] = useState(0);
  const [displayedEntries, setDisplayedEntries] = useState(0);
  const [authChecked, setAuthChecked] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const [filters, setFilters] = useState({
    startDate: '',
    endDate: '',
  });
  const [activeTab, setActiveTab] = useState('overview');
  const [metrics, setMetrics] = useState<MetricData[]>([]);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsStats, setMetricsStats] = useState<{
    avgResponseTime: number;
    totalTokens: number;
    totalErrors: number;
    avgRepetition: number;
    responseTimeCount?: number;
    repetitionCount?: number;
  } | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationStats, setConversationStats] = useState<ConversationStats | null>(null);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [emotions, setEmotions] = useState<EmotionData[]>([]);
  const [emotionsLoading, setEmotionsLoading] = useState(false);
  // A tab whose data didn't load says so, rather than looking empty.
  const [tabErrors, setTabErrors] = useState<{ metrics?: boolean; conversations?: boolean; emotions?: boolean }>({});
  const [conversationPage, setConversationPage] = useState(1);
  const [usagePage, setUsagePage] = useState(1);
  const [usagePageSize] = useState(50);

  useEffect(() => {
    async function init() {
      // Get bot ID from params
      const resolvedParams = await params;
      setBotId(resolvedParams.id);
      
      // Check auth
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
        setAuthChecked(true);
        // Don't set loading to false here - wait for fetchBot to complete
      } catch (err) {
        router.push('/admin/login');
      }
    }
    init();
  }, [params, router, replacePage]);

  const fetchBot = useCallback(async () => {
    if (!botId) return;
    
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      const queryParams = new URLSearchParams();
      if (filters.startDate) queryParams.append('startDate', filters.startDate);
      if (filters.endDate) queryParams.append('endDate', filters.endDate);

      const response = await authenticatedFetch(`/api/admin/bots/${botId}?${queryParams.toString()}`);

      if (!response.ok) {
        if (response.status === 404) {
          setError('Bot not found');
          setLoading(false);
          return;
        }
        if (response.status === 401 || response.status === 403) {
          replacePage('/admin');
          return;
        }
        throw new Error('Failed to fetch bot details');
      }

      const data = await response.json();
      setBot(data.bot);
      setUsage(data.usage);
      setStats(data.stats);
      setTotalEntries(data.totalEntries || 0);
      setDisplayedEntries(data.displayedEntries || data.usage?.length || 0);
      
      // If bot doesn't exist but we have usage data, show a warning
      if (!data.botExists && data.usage && data.usage.length > 0) {
        setError('Bot was deleted, but usage history is preserved below.');
      } else if (!data.botExists) {
        setError('Bot not found');
      } else {
        setError(null);
      }
      
      setInitialLoad(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setInitialLoad(false);
    } finally {
      setLoading(false);
    }
  }, [botId, filters, replacePage]);

  useEffect(() => {
    if (botId && authChecked) {
      fetchBot();
    }
  }, [botId, authChecked, fetchBot]);

  // Fetch metrics when metrics tab is active
  useEffect(() => {
    if (activeTab === 'metrics' && botId && !metricsLoading) {
      fetchMetrics();
    }
  }, [activeTab, botId, filters.startDate, filters.endDate]);

  // Fetch conversations when conversations tab is active
  useEffect(() => {
    if (activeTab === 'conversations' && botId && !conversationsLoading) {
      fetchConversations();
      fetchConversationStats();
    }
  }, [activeTab, botId, conversationPage]);

  // Fetch emotions when emotions tab is active
  useEffect(() => {
    if (activeTab === 'emotions' && botId && !emotionsLoading && emotions.length === 0) {
      fetchEmotions();
    }
  }, [activeTab, botId]);

  async function fetchMetrics() {
    if (!botId) return;
    try {
      setMetricsLoading(true);
      setTabErrors((prev) => ({ ...prev, metrics: false }));
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      const params = new URLSearchParams();
      params.append('limit', '1000'); // Increase limit to get more metric entries
      if (filters.startDate) {
        // Create date at start of day in local timezone
        const startDate = new Date(filters.startDate);
        startDate.setHours(0, 0, 0, 0);
        params.append('startTime', startDate.getTime().toString());
      }
      if (filters.endDate) {
        // Create date at end of day in local timezone
        const endDate = new Date(filters.endDate);
        endDate.setHours(23, 59, 59, 999);
        params.append('endTime', endDate.getTime().toString());
      }

      // Fetch both grouped metrics (for charts) and stats (for summary cards)
      const [metricsResponse, statsResponse] = await Promise.all([
        authenticatedFetch(`/api/bots/${botId}/metrics?${params.toString()}`),
        authenticatedFetch(`/api/bots/${botId}/metrics/stats?${params.toString()}`),
      ]);

      if (metricsResponse.ok) {
        const data = await metricsResponse.json();
        console.log('Fetched metrics:', data?.length || 0, 'entries');
        if (data && data.length > 0) {
          console.log('Sample metric:', data[0]);
        }
        setMetrics(data || []);
      } else {
        const errorText = await metricsResponse.text();
        console.error('Failed to fetch metrics:', metricsResponse.status, errorText);
        setTabErrors((prev) => ({ ...prev, metrics: true }));
      }

      if (statsResponse.ok) {
        const stats = await statsResponse.json();
        console.log('Fetched metrics stats:', stats);
        setMetricsStats(stats);
      } else {
        console.error('Failed to fetch metrics stats:', statsResponse.status);
      }
    } catch (err) {
      console.error('Error fetching metrics:', err);
      setTabErrors((prev) => ({ ...prev, metrics: true }));
    } finally {
      setMetricsLoading(false);
    }
  }

  async function fetchConversations() {
    if (!botId) return;
    try {
      setConversationsLoading(true);
      setTabErrors((prev) => ({ ...prev, conversations: false }));
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      const params = new URLSearchParams();
      params.append('limit', '50');
      params.append('offset', ((conversationPage - 1) * 50).toString());
      if (filters.startDate) {
        params.append('startDate', new Date(filters.startDate).getTime().toString());
      }
      if (filters.endDate) {
        params.append('endDate', new Date(filters.endDate).getTime().toString());
      }

      const response = await authenticatedFetch(`/api/bots/${botId}/conversations?${params.toString()}`);
      if (response.ok) {
        const data = await response.json();
        setConversations(data.conversations || []);
      } else {
        setTabErrors((prev) => ({ ...prev, conversations: true }));
      }
    } catch (err) {
      console.error('Error fetching conversations:', err);
      setTabErrors((prev) => ({ ...prev, conversations: true }));
    } finally {
      setConversationsLoading(false);
    }
  }

  async function fetchConversationStats() {
    if (!botId) return;
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/bots/${botId}/conversations/stats`);
      if (response.ok) {
        const data = await response.json();
        setConversationStats(data);
      }
    } catch (err) {
      console.error('Error fetching conversation stats:', err);
    }
  }

  async function fetchEmotions() {
    if (!botId) return;
    try {
      setEmotionsLoading(true);
      setTabErrors((prev) => ({ ...prev, emotions: false }));
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/bots/${botId}/emotions`);
      if (response.ok) {
        const data = await response.json();
        setEmotions(data || []);
      } else {
        setTabErrors((prev) => ({ ...prev, emotions: true }));
      }
    } catch (err) {
      console.error('Error fetching emotions:', err);
      setTabErrors((prev) => ({ ...prev, emotions: true }));
    } finally {
      setEmotionsLoading(false);
    }
  }

  function formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    return 'Just now';
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

  function formatDate(dateString: string): string {
    return new Date(dateString).toLocaleString();
  }

  function formatConversationDuration(startedAt: string, endedAt: string): string {
    const start = new Date(startedAt).getTime();
    const end = new Date(endedAt).getTime();
    const seconds = Math.floor((end - start) / 1000);
    
    // Handle active conversations (where ended_at = started_at)
    if (seconds === 0) return "Active";
    
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  function getConversationStatus(startedAt: string, endedAt: string): 'active' | 'completed' {
    const start = new Date(startedAt).getTime();
    const end = new Date(endedAt).getTime();
    return start === end ? 'active' : 'completed';
  }

  function formatEndReason(endReason: string | null | undefined): string {
    if (!endReason) return '';
    
    switch (endReason) {
      case 'user_left': return 'User Left';
      case 'bot_shutdown': return 'Bot Shutdown';
      case 'timeout': return 'Timeout';
      case 'manual': return 'Manual';
      default: return endReason;
    }
  }

  const pager = (page: number, totalPages: number, total: number, noun: [string, string], onChange: (page: number) => void) => (
    <Pager page={page} totalPages={totalPages} total={total} noun={noun} onChange={(next) => onChange(Math.max(1, Math.min(totalPages, next)))} />
  );

  if (loading || initialLoad) {
    return (
      <div className="grid min-w-0 gap-6">
        <LoadingRows label="the bot" rows={3} />
      </div>
    );
  }

  // Nothing to show at all: the bot is gone (and left no usage), or it couldn't be loaded.
  if (!bot && usage.length === 0) {
    return (
      <div className="grid min-w-0 gap-6">
        {error && error !== 'Bot not found' ? (
          <LoadError label="this bot" retry={fetchBot} />
        ) : (
          <EmptyCard kind="bot" title="This bot doesn’t exist." text="It may have been deleted." href="/admin/bots" action="All bots" />
        )}
      </div>
    );
  }

  const dateFilters = (idPrefix: string, onChange: () => void) => (
    <FilterRow label="Date range" className="lg:grid-cols-2">
      <DateFilter
        id={`${idPrefix}StartDate`}
        label="From"
        value={filters.startDate}
        onChange={(startDate) => {
          setFilters({ ...filters, startDate });
          onChange();
        }}
      />
      <DateFilter
        id={`${idPrefix}EndDate`}
        label="To"
        value={filters.endDate}
        onChange={(endDate) => {
          setFilters({ ...filters, endDate });
          onChange();
        }}
      />
    </FilterRow>
  );

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        kind="bot"
        title={bot ? bot.name : 'Deleted bot'}
        context={
          bot ? (
            <InContext
              parts={[
                { label: bot.room.world.universe.name, href: `/admin/universes/${bot.room.world.universe.id}` },
                { label: bot.room.world.name, href: `/admin/worlds/${bot.room.world.id}` },
                { label: bot.room.name, href: `/admin/rooms/${bot.room.id}` },
              ]}
            />
          ) : (
            <span>Its usage history is kept below.</span>
          )
        }
        status={bot ? <Pill tone={bot.enabled ? 'ok' : 'off'}>{bot.enabled ? 'Enabled' : 'Disabled'}</Pill> : undefined}
        actions={
          bot ? (
            <Button variant="outline" asChild>
              <Link href={`/admin/bots/${bot.id}/mcp-servers`}>
                <Server aria-hidden="true" />
                MCP servers
              </Link>
            </Button>
          ) : undefined
        }
      />

      {error && (
        <Alert variant={error.includes('deleted') ? 'default' : 'destructive'}>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="min-w-0">
        <TabsList className="flex h-auto w-full justify-start gap-1 overflow-x-auto rounded-xl p-1">
          <TabsTrigger value="overview" className="min-h-11 shrink-0 px-4">Overview</TabsTrigger>
          <TabsTrigger value="usage" className="min-h-11 shrink-0 px-4">Usage</TabsTrigger>
          <TabsTrigger value="metrics" className="min-h-11 shrink-0 px-4">Metrics</TabsTrigger>
          <TabsTrigger value="conversations" className="min-h-11 shrink-0 px-4">Conversations</TabsTrigger>
          <TabsTrigger value="emotions" className="min-h-11 shrink-0 px-4">Emotions</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6 grid min-w-0 gap-6">
          {bot ? (
            <>
              <section aria-labelledby="bot-details" className="min-w-0">
                <SectionHeader id="bot-details" title="Details" />
                <div className="rounded-2xl border bg-card p-4 sm:p-5">
                  <dl className="grid gap-4 sm:grid-cols-2">
                    {bot.description && (
                      <div className="sm:col-span-2">
                        <Detail label="Description">{bot.description}</Detail>
                      </div>
                    )}
                    <Detail label="AI provider">
                      {bot.aiProviderRef ? (
                        <Link href={`/admin/ai-providers/${bot.aiProviderRef}`} className="underline-offset-4 hover:underline">
                          {bot.aiProviderRef}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </Detail>
                    <Detail label="Behavior">{bot.behaviorType}</Detail>
                    <Detail label="Room">
                      <Link href={`/admin/rooms/${bot.room.id}`} className="underline-offset-4 hover:underline">
                        {bot.room.name}
                      </Link>
                    </Detail>
                    <Detail label="World">
                      <Link href={`/admin/worlds/${bot.room.world.id}`} className="underline-offset-4 hover:underline">
                        {bot.room.world.name}
                      </Link>
                    </Detail>
                    <Detail label="Universe">
                      <Link href={`/admin/universes/${bot.room.world.universe.id}`} className="underline-offset-4 hover:underline">
                        {bot.room.world.universe.name}
                      </Link>
                    </Detail>
                    {bot.createdBy && <Detail label="Created by">{bot.createdBy.name || bot.createdBy.email}</Detail>}
                    <Detail label="Created">{formatDate(bot.createdAt)}</Detail>
                  </dl>
                  <details className="mt-4 border-t pt-4">
                    <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Advanced</summary>
                    <dl className="mt-3">
                      <Detail label="Bot ID">
                        <code className="font-mono text-xs">{bot.id}</code>
                      </Detail>
                    </dl>
                  </details>
                </div>
              </section>

              <BotTexturePicker botId={bot.id} currentTextureId={bot.characterTextureId} onTextureChanged={fetchBot} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">This bot was deleted. Its usage history is under Usage.</p>
          )}
        </TabsContent>

        <TabsContent value="usage" className="mt-6 grid min-w-0 gap-6">
          {stats && (
            <Figures>
              <Figure value={stats.totalCalls} label="API calls" />
              <Figure value={stats.totalTokens} label="tokens" />
              <Figure value={formatCurrency(stats.totalCost)} label="cost" />
              <Figure value={formatDuration(stats.totalDuration)} label="duration" />
              <Figure
                value={stats.errorCount}
                label={stats.totalCalls > 0 ? `errors · ${((stats.errorCount / stats.totalCalls) * 100).toFixed(2)}% error rate` : 'errors'}
              />
            </Figures>
          )}

          {stats && Object.keys(stats.byProvider).length > 0 && (
            <section aria-labelledby="usage-providers" className="min-w-0">
              <SectionHeader id="usage-providers" title="By provider" count={Object.keys(stats.byProvider).length} />
              <div className="grid min-w-0 gap-0.5">
                {Object.values(stats.byProvider).map((provider) => (
                  <EntityRow
                    key={provider.providerId}
                    href={`/admin/ai-providers/${provider.providerId}`}
                    kind="provider"
                    title={provider.providerName}
                    context={<StatLine items={[provider.providerType, provider.providerId]} />}
                    meta={
                      <StatLine
                        items={[
                          count(provider.calls, 'call'),
                          count(provider.tokens, 'token'),
                          provider.errors > 0 && count(provider.errors, 'error'),
                        ]}
                      />
                    }
                    aside={<strong className="text-sm">{formatCurrency(provider.cost)}</strong>}
                  />
                ))}
              </div>
            </section>
          )}

          {dateFilters('usage', () => setUsagePage(1))}

          <section aria-labelledby="usage-history" className="min-w-0">
            <SectionHeader id="usage-history" title="Usage history" count={displayedEntries} />
            {usage.length === 0 ? (
              <p className="text-sm text-muted-foreground">No usage in this range.</p>
            ) : (
              <>
                <Panel>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Time</TableHead>
                          <TableHead>Provider</TableHead>
                          <TableHead>API calls</TableHead>
                          <TableHead>Tokens</TableHead>
                          <TableHead>Cost</TableHead>
                          <TableHead>Duration</TableHead>
                          <TableHead>Latency</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {usage.slice((usagePage - 1) * usagePageSize, usagePage * usagePageSize).map((entry) => (
                          <TableRow key={entry.id}>
                            <TableCell>{formatDate(entry.timestamp)}</TableCell>
                            <TableCell>
                              <Link href={`/admin/ai-providers/${entry.provider.providerId}`} className="underline-offset-4 hover:underline">
                                {entry.provider.name}
                              </Link>
                            </TableCell>
                            <TableCell>{formatNumber(entry.apiCalls)}</TableCell>
                            <TableCell>{formatNumber(entry.tokensUsed)}</TableCell>
                            <TableCell>{entry.cost ? formatCurrency(entry.cost) : 'N/A'}</TableCell>
                            <TableCell>{entry.durationSeconds ? formatDuration(entry.durationSeconds) : 'N/A'}</TableCell>
                            <TableCell>{entry.latency ? `${entry.latency}ms` : 'N/A'}</TableCell>
                            <TableCell>
                              <Pill tone={entry.error ? 'bad' : 'ok'}>{entry.error ? 'Error' : 'Success'}</Pill>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </Panel>
                {pager(usagePage, Math.ceil(usage.length / usagePageSize), displayedEntries, ['entry', 'entries'], setUsagePage)}
                {totalEntries > displayedEntries && (
                  <p className="text-xs text-muted-foreground">
                    Showing the latest {formatNumber(displayedEntries)} of {formatNumber(totalEntries)} entries.
                  </p>
                )}
              </>
            )}
          </section>
        </TabsContent>

        <TabsContent value="metrics" className="mt-6 grid min-w-0 gap-6">
          {dateFilters('metrics', fetchMetrics)}

          {metricsLoading ? (
            <LoadingRows label="metrics" rows={3} />
          ) : tabErrors.metrics ? (
            <LoadError label="metrics" retry={fetchMetrics} />
          ) : !metrics || metrics.length === 0 ? (
            <EmptyCard kind="bot" title="No metrics yet." text="Metrics appear here once the bot starts collecting performance data." />
          ) : (
            <>
              {(() => {
                // Use stats from dedicated endpoint if available (more accurate)
                // Otherwise fall back to calculating from grouped metrics
                const avgResponseTime = metricsStats?.avgResponseTime ??
                  (metrics.filter(m => m?.metrics?.responseTime != null && typeof m.metrics.responseTime === 'number' && m.metrics.responseTime > 0).length > 0
                    ? metrics.filter(m => m?.metrics?.responseTime != null && typeof m.metrics.responseTime === 'number' && m.metrics.responseTime > 0)
                        .reduce((sum, m) => sum + (m.metrics.responseTime || 0), 0) /
                      metrics.filter(m => m?.metrics?.responseTime != null && typeof m.metrics.responseTime === 'number' && m.metrics.responseTime > 0).length
                    : 0);

                const totalTokens = metricsStats?.totalTokens ??
                  metrics.reduce((sum, m) => {
                    const tokenTotal = m?.metrics?.tokenUsage?.total;
                    return sum + (tokenTotal != null && typeof tokenTotal === 'number' ? tokenTotal : 0);
                  }, 0);

                const totalErrors = metricsStats?.totalErrors ??
                  metrics.reduce((sum, m) => {
                    const errorCount = m?.metrics?.errorCount;
                    return sum + (errorCount != null && typeof errorCount === 'number' ? errorCount : 0);
                  }, 0);

                const avgRepetition = metricsStats?.avgRepetition ??
                  (metrics.filter(m => m?.metrics?.repetitionScore != null && typeof m.metrics.repetitionScore === 'number').length > 0
                    ? metrics.filter(m => m?.metrics?.repetitionScore != null && typeof m.metrics.repetitionScore === 'number')
                        .reduce((sum, m) => sum + (m.metrics.repetitionScore || 0), 0) /
                      metrics.filter(m => m?.metrics?.repetitionScore != null && typeof m.metrics.repetitionScore === 'number').length
                    : 0);

                const notSent = [
                  metricsStats && metricsStats.responseTimeCount === 0 && 'response time',
                  metricsStats && totalTokens === 0 && 'tokens',
                  metricsStats && totalErrors === 0 && 'errors',
                  metricsStats && metricsStats.repetitionCount === 0 && 'repetition',
                ].filter(Boolean);

                return (
                  <div className="grid gap-2">
                    <Figures>
                      <Figure value={`${avgResponseTime.toFixed(0)}ms`} label="avg response time" />
                      <Figure value={totalTokens} label="tokens" />
                      <Figure value={totalErrors} label="errors" />
                      <Figure value={avgRepetition.toFixed(2)} label="avg repetition score" />
                    </Figures>
                    {notSent.length > 0 && (
                      <p className="text-xs text-muted-foreground">Not sent by this bot: {notSent.join(', ')}.</p>
                    )}
                  </div>
                );
              })()}

              {metrics.some(m => m.metrics.responseTime) && (
                <ChartSection id="chart-response-time" title="Response time">
                  <LineChart data={metrics.filter(m => m.metrics.responseTime).map(m => ({
                    time: new Date(m.timestamp).toLocaleString(),
                    timestamp: m.timestamp,
                    responseTime: m.metrics.responseTime,
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" tick={{ fontSize: 12 }} />
                    <YAxis label={{ value: 'ms', angle: -90, position: 'insideLeft' }} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="responseTime" stroke="#4156f6" name="Response time (ms)" />
                  </LineChart>
                </ChartSection>
              )}

              {metrics.some(m => m.metrics.tokenUsage?.total) && (
                <ChartSection id="chart-tokens" title="Token usage">
                  <LineChart data={metrics.filter(m => m.metrics.tokenUsage?.total).map(m => ({
                    time: new Date(m.timestamp).toLocaleString(),
                    timestamp: m.timestamp,
                    total: m.metrics.tokenUsage?.total || 0,
                    prompt: m.metrics.tokenUsage?.prompt || 0,
                    completion: m.metrics.tokenUsage?.completion || 0,
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" tick={{ fontSize: 12 }} />
                    <YAxis label={{ value: 'Tokens', angle: -90, position: 'insideLeft' }} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="total" stroke="#10b981" name="Total" />
                    <Line type="monotone" dataKey="prompt" stroke="#4156f6" name="Prompt" />
                    <Line type="monotone" dataKey="completion" stroke="#f59e0b" name="Completion" />
                  </LineChart>
                </ChartSection>
              )}

              {metrics.some(m => m.metrics.errorCount) && (
                <ChartSection id="chart-errors" title="Errors">
                  <LineChart data={metrics.filter(m => m.metrics.errorCount).map(m => ({
                    time: new Date(m.timestamp).toLocaleString(),
                    timestamp: m.timestamp,
                    errorCount: m.metrics.errorCount || 0,
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" tick={{ fontSize: 12 }} />
                    <YAxis label={{ value: 'Errors', angle: -90, position: 'insideLeft' }} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="errorCount" stroke="#ef4444" name="Errors" />
                  </LineChart>
                </ChartSection>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="conversations" className="mt-6 grid min-w-0 gap-6">
          {conversationStats && (
            <Figures>
              <Figure value={conversationStats.totalConversations} label="conversations" />
              <Figure value={new Date(conversationStats.oldestConversation).toLocaleDateString()} label="oldest" />
              <Figure value={new Date(conversationStats.newestConversation).toLocaleDateString()} label="newest" />
            </Figures>
          )}

          {dateFilters('conv', () => setConversationPage(1))}

          {conversationsLoading ? (
            <LoadingRows label="conversations" rows={4} />
          ) : tabErrors.conversations ? (
            <LoadError label="conversations" retry={fetchConversations} />
          ) : conversations.length === 0 ? (
            <EmptyCard kind="bot" title="No conversations yet." text="Conversations appear here once players talk to this bot." />
          ) : (
            <div className="grid min-w-0 gap-2">
              {conversations.map((conv) => (
                <Collapsible key={conv.id} className="min-w-0 rounded-2xl border bg-card">
                  <CollapsibleTrigger className="group flex min-h-11 w-full items-start justify-between gap-3 rounded-2xl p-4 text-left hover:bg-muted/40">
                    <span className="min-w-0 space-y-1.5">
                      <strong className="block text-sm [overflow-wrap:anywhere]">
                        {conv.user?.name || conv.userName || conv.userUuid || 'Unknown player'}
                      </strong>
                      <StatLine
                        items={[
                          formatRelativeTime(new Date(conv.endedAt).getTime()),
                          count(conv.messageCount, 'message'),
                          formatConversationDuration(conv.startedAt, conv.endedAt),
                        ]}
                      />
                      <span className="flex flex-wrap gap-1.5">
                        <Pill tone={getConversationStatus(conv.startedAt, conv.endedAt) === 'active' ? 'ok' : 'off'}>
                          {getConversationStatus(conv.startedAt, conv.endedAt) === 'active' ? 'Active' : 'Completed'}
                        </Pill>
                        {conv.endReason && <Pill>{formatEndReason(conv.endReason)}</Pill>}
                        {conv.isGuest && <Pill>Guest</Pill>}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                      <span className="hidden sm:inline">{new Date(conv.endedAt).toLocaleString()}</span>
                      <ChevronDown className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
                    </span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="space-y-3 border-t p-4">
                      {(conv.messages as Array<{ sender: string; message: string; timestamp: number }>).map((msg, idx) => (
                        <div key={idx} className={`flex ${msg.sender === 'bot' ? 'justify-start' : 'justify-end'}`}>
                          <div
                            className={`max-w-[80%] rounded-xl p-3 ${
                              msg.sender === 'bot' ? 'bg-muted' : 'bg-primary text-primary-foreground'
                            }`}
                          >
                            <div className="mb-1 text-xs opacity-70">{msg.sender === 'bot' ? 'Bot' : 'Player'}</div>
                            <div className="text-sm [overflow-wrap:anywhere]">{msg.message}</div>
                            <div className="mt-1 text-xs opacity-70">{new Date(msg.timestamp).toLocaleTimeString()}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}

              {conversationStats &&
                pager(
                  conversationPage,
                  Math.ceil(conversationStats.totalConversations / 50),
                  conversationStats.totalConversations,
                  ['conversation', 'conversations'],
                  setConversationPage,
                )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="emotions" className="mt-6 grid min-w-0 gap-6">
          {emotionsLoading ? (
            <LoadingRows label="emotions" rows={2} />
          ) : tabErrors.emotions ? (
            <LoadError label="emotions" retry={fetchEmotions} />
          ) : emotions.length === 0 ? (
            <EmptyCard kind="bot" title="No emotions yet." text="Emotions appear here once the bot starts tracking how it and players feel." />
          ) : (
            <div className="grid min-w-0 gap-3 md:grid-cols-2">
              {emotions.map((emotion) => (
                <article key={emotion.userUuid} className="min-w-0 space-y-5 rounded-2xl border bg-card p-4 sm:p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="orbit-display text-base font-semibold [overflow-wrap:anywhere]">
                      {emotion.user?.name || emotion.userName || emotion.userUuid || 'Unknown player'}
                    </h3>
                    {emotion.isGuest && <Pill>Guest</Pill>}
                  </div>
                  {emotion.emotions.botEmotion && <EmotionRings title="Bot emotion" values={emotion.emotions.botEmotion} />}
                  {emotion.emotions.personEmotion && <EmotionRings title="Player emotion" values={emotion.emotions.personEmotion} />}
                  {emotion.lastEmotionUpdate && (
                    <p className="border-t pt-2 text-xs text-muted-foreground">
                      Last updated {formatRelativeTime(emotion.lastEmotionUpdate).toLowerCase()}
                    </p>
                  )}
                </article>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ChartSection({ id, title, children }: { id: string; title: string; children: ReactElement }) {
  return (
    <section aria-labelledby={id} className="min-w-0">
      <SectionHeader id={id} title={title} />
      <Panel className="p-4">
        <ResponsiveContainer width="100%" height={300}>
          {children}
        </ResponsiveContainer>
      </Panel>
    </section>
  );
}

/** Each emotion as a ring, 0–100. */
function EmotionRings({ title, values }: { title: string; values: Record<string, number> }) {
  const circumference = 2 * Math.PI * 36;
  return (
    <div>
      <div className="mb-4 text-sm font-medium text-muted-foreground">{title}</div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {Object.entries(values).map(([key, value]) => {
          // Values are already out of 100, so use directly (clamp to 0-100)
          const percentage = Math.min(100, Math.max(0, value as number));
          const offset = circumference - (percentage / 100) * circumference;
          return (
            <div key={key} className="flex flex-col items-center gap-2">
              <div className="relative h-20 w-20">
                <svg className="h-20 w-20 -rotate-90 transform" viewBox="0 0 80 80" aria-hidden="true">
                  <circle cx="40" cy="40" r="36" stroke="currentColor" strokeWidth="6" fill="none" className="text-muted" />
                  <circle
                    cx="40"
                    cy="40"
                    r="36"
                    stroke="currentColor"
                    strokeWidth="6"
                    fill="none"
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    strokeLinecap="round"
                    className="text-foreground/80 transition-all duration-500"
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-xs font-semibold">{Math.round(percentage)}%</span>
                </div>
              </div>
              <span className="text-center text-xs capitalize text-muted-foreground">{key}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
