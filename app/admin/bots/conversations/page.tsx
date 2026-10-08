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
import { EmptyCard, LoadError, LoadingRows, PageHeader } from '../../components/ds';
import { ApplyFilter, DateFilter, FilterRow, JsonDetails, ListPager, Panel, Pill, type PageInfo } from '../bots-ui';
import { useReplacePage } from '@/app/admin/orbit-frame-context';

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
  messages: any;
  messageCount: number;
  startedAt: Date;
  endedAt: Date;
  endReason?: string | null;
  createdAt: Date;
}

export default function ConversationsBrowsePage() {
  const router = useRouter();
  const replacePage = useReplacePage();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<PageInfo | null>(null);
  const [filters, setFilters] = useState({
    botId: '',
    userUuid: '',
    userId: '',
    startDate: '',
    endDate: '',
    page: 1,
    limit: 50,
  });
  const [botIdInput, setBotIdInput] = useState('');
  const [userUuidInput, setUserUuidInput] = useState('');
  const [userIdInput, setUserIdInput] = useState('');

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (!loading) {
      const timer = setTimeout(() => {
        fetchConversations();
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
      fetchConversations();
    } catch (err) {
      router.push('/admin/login');
    }
  }

  const fetchConversations = useCallback(async () => {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      const params = new URLSearchParams();
      params.append('page', filters.page.toString());
      params.append('limit', filters.limit.toString());
      if (filters.botId) params.append('botId', filters.botId);
      if (filters.userUuid) params.append('userUuid', filters.userUuid);
      if (filters.userId) params.append('userId', filters.userId);
      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);

      const response = await authenticatedFetch(`/api/admin/bots/conversations?${params.toString()}`);

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          replacePage('/admin');
          return;
        }
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `Failed to fetch conversations (${response.status})`);
      }

      const data = await response.json();
      setConversations(data.conversations || []);
      setPagination(data.pagination || null);
      setError(null);
    } catch (err) {
      console.error('Error fetching conversations:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [filters, replacePage]);

  const handlePageChange = (newPage: number) => {
    setFilters({ ...filters, page: newPage });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  function formatDate(date: Date | string): string {
    return new Date(date).toLocaleString();
  }


  function formatDuration(startedAt: Date | string, endedAt: Date | string): string {
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

  function getConversationStatus(startedAt: Date | string, endedAt: Date | string): 'active' | 'completed' {
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

  const filtered = Boolean(filters.botId || filters.userUuid || filters.userId || filters.startDate || filters.endDate);

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        kind="bot"
        title="Conversations"
        context={<span>What players and bots said to each other, across every bot.</span>}
      />

      <FilterRow label="Filter conversations" className="lg:grid-cols-5">
        <ApplyFilter
          id="botId"
          label="Bot ID"
          placeholder="Bot ID"
          value={botIdInput}
          onChange={setBotIdInput}
          onApply={() => setFilters({ ...filters, botId: botIdInput, page: 1 })}
        />
        <ApplyFilter
          id="userUuid"
          label="User UUID"
          placeholder="User UUID"
          value={userUuidInput}
          onChange={setUserUuidInput}
          onApply={() => setFilters({ ...filters, userUuid: userUuidInput, page: 1 })}
        />
        <ApplyFilter
          id="userId"
          label="User ID"
          placeholder="User ID"
          value={userIdInput}
          onChange={setUserIdInput}
          onApply={() => setFilters({ ...filters, userId: userIdInput, page: 1 })}
        />
        <DateFilter id="startDate" label="From" value={filters.startDate} onChange={(startDate) => setFilters({ ...filters, startDate, page: 1 })} />
        <DateFilter id="endDate" label="To" value={filters.endDate} onChange={(endDate) => setFilters({ ...filters, endDate, page: 1 })} />
      </FilterRow>

      {error && <LoadError label="conversations" retry={fetchConversations} />}

      {loading && conversations.length === 0 ? (
        <LoadingRows label="conversations" rows={5} />
      ) : conversations.length === 0 ? (
        !error &&
        (filtered ? (
          <p className="text-sm text-muted-foreground" role="status">
            No conversations match these filters.
          </p>
        ) : (
          <EmptyCard kind="bot" title="No conversations yet." text="Conversations show up here once players talk to a bot." />
        ))
      ) : (
            <>
              <Panel>
              {/* Desktop Table View */}
              <div className="hidden md:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Bot ID</TableHead>
                      <TableHead>Player</TableHead>
                      <TableHead>Messages</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Started</TableHead>
                      <TableHead>Ended</TableHead>
                      <TableHead>Transcript</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {conversations.map((conv) => (
                      <TableRow key={conv.id}>
                        <TableCell>
                          <AuthLink
                            href={`/admin/bots/${conv.botId}`}
                            className="text-primary hover:underline font-mono text-sm"
                          >
                            {conv.botId}
                          </AuthLink>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            {conv.user ? (
                              <>
                                <div className="font-semibold">{conv.user.name || conv.userName || 'Unknown'}</div>
                                {conv.user.email && (
                                  <div className="text-xs text-muted-foreground">{conv.user.email}</div>
                                )}
                                <div className="text-xs font-mono text-muted-foreground">
                                  {conv.userId || conv.userUuid || 'N/A'}
                                </div>
                                {conv.isGuest && (
                                  <Pill>Guest</Pill>
                                )}
                              </>
                            ) : (
                              <>
                                <div className="font-semibold">{conv.userName || 'Unknown'}</div>
                                <div className="text-xs font-mono text-muted-foreground">
                                  {conv.userUuid || 'N/A'}
                                </div>
                                {conv.isGuest && (
                                  <Pill>Guest</Pill>
                                )}
                              </>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Pill>{conv.messageCount}</Pill>
                        </TableCell>
                        <TableCell className="text-sm">
                          {formatDuration(conv.startedAt, conv.endedAt)}
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            <Pill tone={getConversationStatus(conv.startedAt, conv.endedAt) === 'active' ? 'ok' : 'off'}>{getConversationStatus(conv.startedAt, conv.endedAt) === 'active' ? 'Active' : 'Completed'}</Pill>
                            {conv.endReason && (
                              <Pill>
                                {formatEndReason(conv.endReason)}
                              </Pill>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{formatDate(conv.startedAt)}</TableCell>
                        <TableCell className="text-sm">{formatDate(conv.endedAt)}</TableCell>
                        <TableCell>
                          <JsonDetails label="View" value={conv.messages} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile Card View */}
              <div className="md:hidden space-y-4 p-4">
                {conversations.map((conv) => (
                  <div key={conv.id} className="rounded-xl border p-4">
                    <div>
                      <div className="space-y-3">
                        <div className="flex items-start justify-between">
                          <div className="space-y-1">
                            <div className="text-sm font-medium text-muted-foreground">Bot ID</div>
                            <AuthLink
                              href={`/admin/bots/${conv.botId}`}
                              className="text-primary hover:underline font-mono text-sm font-semibold"
                            >
                              {conv.botId}
                            </AuthLink>
                          </div>
                          <Pill>{conv.messageCount} messages</Pill>
                        </div>
                        <div>
                          <div className="text-sm font-medium text-muted-foreground mb-1">User</div>
                          {conv.user ? (
                            <>
                              <div className="font-semibold">{conv.user.name || conv.userName || 'Unknown'}</div>
                              {conv.user.email && (
                                <div className="text-xs text-muted-foreground">{conv.user.email}</div>
                              )}
                              <div className="text-xs font-mono text-muted-foreground">
                                {conv.userId || conv.userUuid || 'N/A'}
                              </div>
                              {conv.isGuest && (
                                <Pill>Guest</Pill>
                              )}
                            </>
                          ) : (
                            <>
                              <div className="font-semibold">{conv.userName || 'Unknown'}</div>
                              <div className="text-xs font-mono text-muted-foreground">
                                {conv.userUuid || 'N/A'}
                              </div>
                              {conv.isGuest && (
                                <Pill>Guest</Pill>
                              )}
                            </>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <div className="text-sm font-medium text-muted-foreground mb-1">Duration</div>
                            <div className="text-sm">{formatDuration(conv.startedAt, conv.endedAt)}</div>
                          </div>
                          <div>
                            <div className="text-sm font-medium text-muted-foreground mb-1">Started</div>
                            <div className="text-sm">{formatDate(conv.startedAt)}</div>
                          </div>
                        </div>
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-sm font-medium text-muted-foreground mb-1">Status</div>
                            <div className="flex items-center gap-2">
                              <Pill tone={getConversationStatus(conv.startedAt, conv.endedAt) === 'active' ? 'ok' : 'off'}>{getConversationStatus(conv.startedAt, conv.endedAt) === 'active' ? 'Active' : 'Completed'}</Pill>
                              {conv.endReason && (
                                <Pill>
                                  {formatEndReason(conv.endReason)}
                                </Pill>
                              )}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-sm font-medium text-muted-foreground mb-1">Ended</div>
                            <div className="text-sm">{formatDate(conv.endedAt)}</div>
                          </div>
                        </div>
                        <div>
                          <JsonDetails label="View messages" value={conv.messages} />
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              </Panel>
              <ListPager pagination={pagination} noun={['conversation', 'conversations']} loading={loading} onChange={handlePageChange} />
            </>
      )}
    </div>
  );
}
