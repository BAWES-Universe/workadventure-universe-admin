'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import AuthLink from '@/app/admin/auth-link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, Loader2, ArrowLeft, Activity, TrendingUp, DollarSign, AlertTriangle, BarChart3, MessageSquare, Heart, Clock } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

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
          router.push('/admin');
          return;
        }
        setAuthChecked(true);
        // Don't set loading to false here - wait for fetchBot to complete
      } catch (err) {
        router.push('/admin/login');
      }
    }
    init();
  }, [params, router]);

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
          router.push('/admin');
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
  }, [botId, filters, router]);

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
    } finally {
      setMetricsLoading(false);
    }
  }

  async function fetchConversations() {
    if (!botId) return;
    try {
      setConversationsLoading(true);
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
      }
    } catch (err) {
      console.error('Error fetching conversations:', err);
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
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/bots/${botId}/emotions`);
      if (response.ok) {
        const data = await response.json();
        setEmotions(data || []);
      }
    } catch (err) {
      console.error('Error fetching emotions:', err);
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

  // Show loading spinner during initial load
  if (loading || initialLoad) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  // Only show "not found" if we've completed the initial load and bot is null
  if (!bot && !initialLoad) {
    return (
      <div className="space-y-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Bot not found</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" asChild>
            <AuthLink href="/admin/bots">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Bots
            </AuthLink>
          </Button>
          <div className="space-y-1">
            <h1 className="text-4xl font-bold tracking-tight">{bot ? bot.name : 'Bot Usage History'}</h1>
            <p className="text-muted-foreground text-lg">
              Bot details and usage history
            </p>
          </div>
        </div>
      </div>

      {error && (
        <Alert variant={error.includes('deleted') ? 'default' : 'destructive'}>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="conversations">Conversations</TabsTrigger>
          <TabsTrigger value="emotions">Emotions</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-6 animate-in fade-in-50 duration-200">
      {/* Bot Details */}
      {bot && (
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Basic Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="text-sm font-medium text-muted-foreground">Bot ID</div>
              <div className="text-base font-mono text-sm">{bot.id}</div>
            </div>
            <div>
              <div className="text-sm font-medium text-muted-foreground">Name</div>
              <div className="text-base">{bot.name}</div>
            </div>
            {bot.description && (
              <div>
                <div className="text-sm font-medium text-muted-foreground">Description</div>
                <div className="text-base">{bot.description}</div>
              </div>
            )}
            <div>
              <div className="text-sm font-medium text-muted-foreground">Status</div>
              <Badge variant={bot.enabled ? 'default' : 'secondary'}>
                {bot.enabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </div>
            {bot.aiProviderRef && (
              <div>
                <div className="text-sm font-medium text-muted-foreground">AI Provider</div>
                <AuthLink
                  href={`/admin/ai-providers/${bot.aiProviderRef}`}
                  className="text-base text-primary hover:underline"
                >
                  {bot.aiProviderRef}
                </AuthLink>
              </div>
            )}
            <div>
              <div className="text-sm font-medium text-muted-foreground">Behavior Type</div>
              <Badge variant="outline">{bot.behaviorType}</Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Location</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="text-sm font-medium text-muted-foreground">Room</div>
              <AuthLink
                href={`/admin/rooms/${bot.room.id}`}
                className="text-base text-primary hover:underline"
              >
                {bot.room.name}
              </AuthLink>
            </div>
            <div>
              <div className="text-sm font-medium text-muted-foreground">World</div>
              <AuthLink
                href={`/admin/worlds/${bot.room.world.id}`}
                className="text-base text-primary hover:underline"
              >
                {bot.room.world.name}
              </AuthLink>
            </div>
            <div>
              <div className="text-sm font-medium text-muted-foreground">Universe</div>
              <AuthLink
                href={`/admin/universes/${bot.room.world.universe.id}`}
                className="text-base text-primary hover:underline"
              >
                {bot.room.world.universe.name}
              </AuthLink>
            </div>
            {bot.createdBy && (
              <div>
                <div className="text-sm font-medium text-muted-foreground">Created By</div>
                <div className="text-base">{bot.createdBy.name || bot.createdBy.email}</div>
              </div>
            )}
            <div>
              <div className="text-sm font-medium text-muted-foreground">Created At</div>
              <div className="text-base">{formatDate(bot.createdAt)}</div>
            </div>
          </CardContent>
        </Card>
      </div>
      )}
        </TabsContent>

        {/* Usage Tab */}
        <TabsContent value="usage" className="space-y-6 animate-in fade-in-50 duration-200">
      {stats && (
        <>
              {/* Usage Statistics */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-5">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total API Calls</CardTitle>
                <Activity className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatNumber(stats.totalCalls)}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Tokens</CardTitle>
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatNumber(stats.totalTokens)}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Cost</CardTitle>
                <DollarSign className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatCurrency(stats.totalCost)}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Duration</CardTitle>
                <Activity className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {formatDuration(stats.totalDuration)}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Errors</CardTitle>
                <AlertTriangle className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatNumber(stats.errorCount)}</div>
                <p className="text-xs text-muted-foreground">
                  {stats.totalCalls > 0
                    ? `${((stats.errorCount / stats.totalCalls) * 100).toFixed(2)}% error rate`
                    : 'N/A'}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Usage by Provider */}
          {Object.keys(stats.byProvider).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Usage by Provider</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {Object.values(stats.byProvider).map((provider) => (
                    <div
                      key={provider.providerId}
                      className="flex items-center justify-between border-b pb-4 last:border-0"
                    >
                      <div>
                        <AuthLink
                          href={`/admin/ai-providers/${provider.providerId}`}
                          className="font-semibold text-primary hover:underline"
                        >
                          {provider.providerName}
                        </AuthLink>
                        <div className="text-sm text-muted-foreground">
                          {provider.providerType} • {provider.providerId}
                        </div>
                      </div>
                      <div className="text-right space-y-1">
                        <div className="text-sm">
                          {formatNumber(provider.calls)} calls • {formatNumber(provider.tokens)} tokens
                        </div>
                        <div className="text-sm font-medium">
                          {formatCurrency(provider.cost)}
                        </div>
                        {provider.errors > 0 && (
                          <div className="text-xs text-destructive">
                            {provider.errors} errors
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
                  <Label htmlFor="usageStartDate">Start Date</Label>
              <Input
                    id="usageStartDate"
                type="date"
                value={filters.startDate}
                    onChange={(e) => {
                      setFilters({ ...filters, startDate: e.target.value });
                      setUsagePage(1);
                    }}
              />
            </div>
            <div className="space-y-2">
                  <Label htmlFor="usageEndDate">End Date</Label>
              <Input
                    id="usageEndDate"
                type="date"
                value={filters.endDate}
                    onChange={(e) => {
                      setFilters({ ...filters, endDate: e.target.value });
                      setUsagePage(1);
                    }}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Usage History Table */}
      <Card>
        <CardHeader>
          <CardTitle>Usage History</CardTitle>
        </CardHeader>
        <CardContent>
          {usage.length === 0 ? (
            <p className="text-sm text-muted-foreground">No usage data available</p>
          ) : (
                <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>API Calls</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead>Cost</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Latency</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                        {usage
                          .slice((usagePage - 1) * usagePageSize, usagePage * usagePageSize)
                          .map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell>{formatDate(entry.timestamp)}</TableCell>
                      <TableCell>
                        <AuthLink
                          href={`/admin/ai-providers/${entry.provider.providerId}`}
                          className="text-primary hover:underline"
                        >
                          {entry.provider.name}
                        </AuthLink>
                      </TableCell>
                      <TableCell>{formatNumber(entry.apiCalls)}</TableCell>
                      <TableCell>{formatNumber(entry.tokensUsed)}</TableCell>
                      <TableCell>
                        {entry.cost ? formatCurrency(entry.cost) : 'N/A'}
                      </TableCell>
                      <TableCell>
                        {entry.durationSeconds ? formatDuration(entry.durationSeconds) : 'N/A'}
                      </TableCell>
                      <TableCell>
                        {entry.latency ? `${entry.latency}ms` : 'N/A'}
                      </TableCell>
                      <TableCell>
                        {entry.error ? (
                          <Badge variant="destructive">Error</Badge>
                        ) : (
                          <Badge variant="default">Success</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

                  {/* Pagination */}
                  {usage.length > usagePageSize && (
                    <div className="flex items-center justify-between mt-4 pt-4 border-t">
                      <div className="text-sm text-muted-foreground">
                        Showing {((usagePage - 1) * usagePageSize) + 1} - {Math.min(usagePage * usagePageSize, usage.length)} of {displayedEntries} entries
                        {totalEntries > displayedEntries && (
                          <span className="ml-2 text-xs italic">
                            (out of {formatNumber(totalEntries)} total)
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setUsagePage(p => Math.max(1, p - 1))}
                          disabled={usagePage === 1}
                        >
                          Previous
                        </Button>
                        <div className="text-sm text-muted-foreground">
                          Page {usagePage} of {Math.ceil(usage.length / usagePageSize)}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setUsagePage(p => p + 1)}
                          disabled={usagePage >= Math.ceil(usage.length / usagePageSize)}
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
        </TabsContent>

        {/* Metrics Tab */}
        <TabsContent value="metrics" className="space-y-6 animate-in fade-in-50 duration-200">
          <Card>
            <CardHeader>
              <CardTitle>Date Range</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="metricsStartDate">Start Date</Label>
                  <Input
                    id="metricsStartDate"
                    type="date"
                    value={filters.startDate}
                    onChange={(e) => {
                      setFilters({ ...filters, startDate: e.target.value });
                      fetchMetrics();
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="metricsEndDate">End Date</Label>
                  <Input
                    id="metricsEndDate"
                    type="date"
                    value={filters.endDate}
                    onChange={(e) => {
                      setFilters({ ...filters, endDate: e.target.value });
                      fetchMetrics();
                    }}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {metricsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : !metrics || metrics.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <BarChart3 className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                <h3 className="text-lg font-semibold mb-2">No metrics available</h3>
                <p className="text-sm text-muted-foreground">
                  Metrics will appear here once the bot starts collecting performance data.
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Metric Summary Cards */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
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

                  return (
                    <>
                      <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                          <CardTitle className="text-sm font-medium">Avg Response Time</CardTitle>
                          <Clock className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                          <div className="text-2xl font-bold">{avgResponseTime.toFixed(0)}ms</div>
                          {metricsStats && metricsStats.responseTimeCount === 0 && (
                            <div className="text-xs text-muted-foreground mt-1">Not available - bot not sending this metric</div>
                          )}
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                          <CardTitle className="text-sm font-medium">Total Tokens</CardTitle>
                          <TrendingUp className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                          <div className="text-2xl font-bold">{formatNumber(totalTokens)}</div>
                          {metricsStats && totalTokens === 0 && (
                            <div className="text-xs text-muted-foreground mt-1">Not available - bot not sending this metric</div>
                          )}
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                          <CardTitle className="text-sm font-medium">Total Errors</CardTitle>
                          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                          <div className="text-2xl font-bold">{formatNumber(totalErrors)}</div>
                          {metricsStats && totalErrors === 0 && (
                            <div className="text-xs text-muted-foreground mt-1">Not available - bot not sending this metric</div>
                          )}
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                          <CardTitle className="text-sm font-medium">Avg Repetition Score</CardTitle>
                          <BarChart3 className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                          <div className="text-2xl font-bold">{avgRepetition.toFixed(2)}</div>
                          {metricsStats && metricsStats.repetitionCount === 0 && (
                            <div className="text-xs text-muted-foreground mt-1">Not available - bot not sending this metric</div>
                          )}
                        </CardContent>
                      </Card>
                    </>
                  );
                })()}
              </div>

              {/* Response Time Chart */}
              {metrics.some(m => m.metrics.responseTime) && (
                <Card>
                  <CardHeader>
                    <CardTitle>Response Time Over Time</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
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
                        <Line type="monotone" dataKey="responseTime" stroke="#8884d8" name="Response Time (ms)" />
                      </LineChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              )}

              {/* Token Usage Chart */}
              {metrics.some(m => m.metrics.tokenUsage?.total) && (
                <Card>
                  <CardHeader>
                    <CardTitle>Token Usage Over Time</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
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
                        <Line type="monotone" dataKey="total" stroke="#82ca9d" name="Total" />
                        <Line type="monotone" dataKey="prompt" stroke="#8884d8" name="Prompt" />
                        <Line type="monotone" dataKey="completion" stroke="#ffc658" name="Completion" />
                      </LineChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              )}

              {/* Error Count Chart */}
              {metrics.some(m => m.metrics.errorCount) && (
                <Card>
                  <CardHeader>
                    <CardTitle>Error Count Over Time</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
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
                        <Line type="monotone" dataKey="errorCount" stroke="#ff6b6b" name="Error Count" />
                      </LineChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        {/* Conversations Tab */}
        <TabsContent value="conversations" className="space-y-6 animate-in fade-in-50 duration-200">
          {conversationStats && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Total Conversations</CardTitle>
                  <MessageSquare className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{formatNumber(conversationStats.totalConversations)}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Oldest</CardTitle>
                  <Clock className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-sm">{new Date(conversationStats.oldestConversation).toLocaleDateString()}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Newest</CardTitle>
                  <Clock className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-sm">{new Date(conversationStats.newestConversation).toLocaleDateString()}</div>
                </CardContent>
              </Card>
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Filters</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="convStartDate">Start Date</Label>
                  <Input
                    id="convStartDate"
                    type="date"
                    value={filters.startDate}
                    onChange={(e) => {
                      setFilters({ ...filters, startDate: e.target.value });
                      setConversationPage(1);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="convEndDate">End Date</Label>
                  <Input
                    id="convEndDate"
                    type="date"
                    value={filters.endDate}
                    onChange={(e) => {
                      setFilters({ ...filters, endDate: e.target.value });
                      setConversationPage(1);
                    }}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {conversationsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : conversations.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <MessageSquare className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                <h3 className="text-lg font-semibold mb-2">No conversations yet</h3>
                <p className="text-sm text-muted-foreground">
                  Conversations will appear here once players interact with this bot.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {conversations.map((conv) => (
                <Collapsible key={conv.id}>
                  <Card>
                    <CollapsibleTrigger className="w-full">
                      <CardHeader>
                        <div className="flex items-center justify-between">
                          <div className="text-left">
                            <CardTitle className="text-base">
                              {conv.user?.name || conv.userName || conv.userUuid || 'Unknown User'}
                            </CardTitle>
                            <div className="text-sm text-muted-foreground mt-1">
                              {formatRelativeTime(new Date(conv.endedAt).getTime())} • {conv.messageCount} messages • {formatConversationDuration(conv.startedAt, conv.endedAt)}
                            </div>
                            <div className="flex items-center gap-2 mt-2">
                              <Badge variant={getConversationStatus(conv.startedAt, conv.endedAt) === 'active' ? 'default' : 'secondary'} className="text-xs">
                                {getConversationStatus(conv.startedAt, conv.endedAt) === 'active' ? 'Active' : 'Completed'}
                              </Badge>
                              {conv.endReason && (
                                <Badge variant="outline" className="text-xs">
                                  {formatEndReason(conv.endReason)}
                                </Badge>
                              )}
                              {conv.isGuest && (
                                <Badge variant="outline" className="text-xs">Guest</Badge>
                              )}
                            </div>
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {new Date(conv.endedAt).toLocaleString()}
                          </div>
                        </div>
                      </CardHeader>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <CardContent>
                        <div className="space-y-3 pt-4 border-t">
                          {(conv.messages as Array<{ sender: string; message: string; timestamp: number }>).map((msg, idx) => (
                            <div
                              key={idx}
                              className={`flex ${msg.sender === 'bot' ? 'justify-start' : 'justify-end'}`}
                            >
                              <div
                                className={`max-w-[80%] rounded-lg p-3 ${
                                  msg.sender === 'bot'
                                    ? 'bg-muted'
                                    : 'bg-primary text-primary-foreground'
                                }`}
                              >
                                <div className="text-xs opacity-70 mb-1">
                                  {msg.sender === 'bot' ? 'Bot' : 'Player'}
                                </div>
                                <div className="text-sm">{msg.message}</div>
                                <div className="text-xs opacity-70 mt-1">
                                  {new Date(msg.timestamp).toLocaleTimeString()}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </CollapsibleContent>
                  </Card>
                </Collapsible>
              ))}

              {/* Pagination */}
              {conversationStats && conversationStats.totalConversations > 50 && (
                <div className="flex items-center justify-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConversationPage(p => Math.max(1, p - 1))}
                    disabled={conversationPage === 1}
                  >
                    Previous
                  </Button>
                  <div className="text-sm text-muted-foreground">
                    Page {conversationPage} of {Math.ceil(conversationStats.totalConversations / 50)}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConversationPage(p => p + 1)}
                    disabled={conversationPage >= Math.ceil(conversationStats.totalConversations / 50)}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
          )}
        </TabsContent>

        {/* Emotions Tab */}
        <TabsContent value="emotions" className="space-y-6 animate-in fade-in-50 duration-200">
          {emotionsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : emotions.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Heart className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                <h3 className="text-lg font-semibold mb-2">No emotion data available</h3>
                <p className="text-sm text-muted-foreground">
                  Emotion data will appear here once the bot starts tracking emotional states.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {emotions.map((emotion) => (
                <Card key={emotion.userUuid}>
                  <CardHeader>
                    <CardTitle>
                      {emotion.user?.name || emotion.userName || emotion.userUuid || 'Unknown User'}
                    </CardTitle>
                    {emotion.isGuest && (
                      <Badge variant="outline" className="text-xs mt-1">Guest</Badge>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-6">
                    {emotion.emotions.botEmotion && (
                      <div>
                        <div className="text-sm font-medium text-muted-foreground mb-4">Bot Emotion</div>
                        <div className="grid grid-cols-2 gap-4">
                          {Object.entries(emotion.emotions.botEmotion).map(([key, value]) => {
                            // Values are already out of 100, so use directly (clamp to 0-100)
                            const percentage = Math.min(100, Math.max(0, value as number));
                            const circumference = 2 * Math.PI * 36; // radius = 36
                            const offset = circumference - (percentage / 100) * circumference;
                            
                            return (
                              <div key={key} className="flex flex-col items-center gap-2">
                                <div className="relative w-20 h-20">
                                  <svg className="w-20 h-20 transform -rotate-90" viewBox="0 0 80 80">
                                    {/* Background circle */}
                                    <circle
                                      cx="40"
                                      cy="40"
                                      r="36"
                                      stroke="currentColor"
                                      strokeWidth="6"
                                      fill="none"
                                      className="text-muted"
                                    />
                                    {/* Progress circle */}
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
                                      className="text-primary transition-all duration-500"
                                    />
                                  </svg>
                                  <div className="absolute inset-0 flex items-center justify-center">
                                    <span className="text-xs font-semibold">{Math.round(percentage)}%</span>
                                  </div>
                                </div>
                                <span className="text-xs capitalize text-center text-muted-foreground">{key}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {emotion.emotions.personEmotion && (
                      <div>
                        <div className="text-sm font-medium text-muted-foreground mb-4">Person Emotion</div>
                        <div className="grid grid-cols-2 gap-4">
                          {Object.entries(emotion.emotions.personEmotion).map(([key, value]) => {
                            // Values are already out of 100, so use directly (clamp to 0-100)
                            const percentage = Math.min(100, Math.max(0, value as number));
                            const circumference = 2 * Math.PI * 36; // radius = 36
                            const offset = circumference - (percentage / 100) * circumference;
                            
                            return (
                              <div key={key} className="flex flex-col items-center gap-2">
                                <div className="relative w-20 h-20">
                                  <svg className="w-20 h-20 transform -rotate-90" viewBox="0 0 80 80">
                                    {/* Background circle */}
                                    <circle
                                      cx="40"
                                      cy="40"
                                      r="36"
                                      stroke="currentColor"
                                      strokeWidth="6"
                                      fill="none"
                                      className="text-muted"
                                    />
                                    {/* Progress circle */}
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
                                      className="text-primary transition-all duration-500"
                                    />
                                  </svg>
                                  <div className="absolute inset-0 flex items-center justify-center">
                                    <span className="text-xs font-semibold">{Math.round(percentage)}%</span>
                                  </div>
                                </div>
                                <span className="text-xs capitalize text-center text-muted-foreground">{key}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {emotion.lastEmotionUpdate && (
                      <div className="text-xs text-muted-foreground pt-2 border-t">
                        Last updated: {formatRelativeTime(emotion.lastEmotionUpdate)}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

