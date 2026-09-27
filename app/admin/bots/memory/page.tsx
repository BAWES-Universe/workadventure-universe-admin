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

interface Memory {
  id: number;
  botId: string;
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
  memories: any;
  emotions: any;
  lastEmotionUpdate: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export default function MemoryBrowsePage() {
  const router = useRouter();
  const [memory, setMemory] = useState<Memory[]>([]);
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
        fetchMemory();
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
      fetchMemory();
    } catch (err) {
      router.push('/admin/login');
    }
  }

  const fetchMemory = useCallback(async () => {
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

      const response = await authenticatedFetch(`/api/admin/bots/memory?${params.toString()}`);

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          router.push('/admin');
          return;
        }
        throw new Error('Failed to fetch memory');
      }

      const data = await response.json();
      setMemory(data.memory || []);
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


  const filtered = Boolean(filters.botId || filters.userUuid || filters.userId || filters.startDate || filters.endDate);

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        kind="bot"
        title="Memory"
        context={<span>What each bot remembers about the players it has met.</span>}
      />

      <FilterRow label="Filter memory" className="lg:grid-cols-5">
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

      {error && <LoadError label="memory" retry={fetchMemory} />}

      {loading && memory.length === 0 ? (
        <LoadingRows label="memory entries" rows={5} />
      ) : memory.length === 0 ? (
        !error &&
        (filtered ? (
          <p className="text-sm text-muted-foreground" role="status">
            No memory entries match these filters.
          </p>
        ) : (
          <EmptyCard kind="bot" title="No memory yet." text="Bots remember players here once they have talked." />
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
                      <TableHead>Last Updated</TableHead>
                      <TableHead>Memories</TableHead>
                      <TableHead>Emotions</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {memory.map((mem) => (
                      <TableRow key={mem.id}>
                        <TableCell>
                          <AuthLink
                            href={`/admin/bots/${mem.botId}`}
                            className="text-primary hover:underline font-mono text-sm"
                          >
                            {mem.botId}
                          </AuthLink>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            {mem.user ? (
                              <>
                                <div className="font-semibold">{mem.user.name || mem.userName || 'Unknown'}</div>
                                {mem.user.email && (
                                  <div className="text-xs text-muted-foreground">{mem.user.email}</div>
                                )}
                                <div className="text-xs font-mono text-muted-foreground">
                                  {mem.userId || mem.userUuid || 'N/A'}
                                </div>
                                {mem.isGuest && (
                                  <Pill>Guest</Pill>
                                )}
                              </>
                            ) : (
                              <>
                                <div className="font-semibold">{mem.userName || 'Unknown'}</div>
                                <div className="text-xs font-mono text-muted-foreground">
                                  {mem.userUuid || 'N/A'}
                                </div>
                                {mem.isGuest && (
                                  <Pill>Guest</Pill>
                                )}
                              </>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{formatDate(mem.updatedAt)}</TableCell>
                        <TableCell>
                          {mem.memories ? (
                            <JsonDetails label="View" value={mem.memories} />
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {mem.emotions ? (
                            <JsonDetails label="View" value={mem.emotions} />
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">{formatDate(mem.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile Card View */}
              <div className="md:hidden space-y-4 p-4">
                {memory.map((mem) => (
                  <div key={mem.id} className="rounded-xl border p-4">
                    <div>
                      <div className="space-y-3">
                        <div className="flex items-start justify-between">
                          <div className="space-y-1">
                            <div className="text-sm font-medium text-muted-foreground">Bot ID</div>
                            <AuthLink
                              href={`/admin/bots/${mem.botId}`}
                              className="text-primary hover:underline font-mono text-sm font-semibold"
                            >
                              {mem.botId}
                            </AuthLink>
                          </div>
                          {mem.isGuest && (
                            <Pill>Guest</Pill>
                          )}
                        </div>
                        <div>
                          <div className="text-sm font-medium text-muted-foreground mb-1">User</div>
                          {mem.user ? (
                            <>
                              <div className="font-semibold">{mem.user.name || mem.userName || 'Unknown'}</div>
                              {mem.user.email && (
                                <div className="text-xs text-muted-foreground">{mem.user.email}</div>
                              )}
                              <div className="text-xs font-mono text-muted-foreground">
                                {mem.userId || mem.userUuid || 'N/A'}
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="font-semibold">{mem.userName || 'Unknown'}</div>
                              <div className="text-xs font-mono text-muted-foreground">
                                {mem.userUuid || 'N/A'}
                              </div>
                            </>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <div className="text-sm font-medium text-muted-foreground mb-1">Last Updated</div>
                            <div className="text-sm">{formatDate(mem.updatedAt)}</div>
                          </div>
                          <div>
                            <div className="text-sm font-medium text-muted-foreground mb-1">Created</div>
                            <div className="text-sm">{formatDate(mem.createdAt)}</div>
                          </div>
                        </div>
                        {mem.memories && (
                          <div>
                            <JsonDetails label="View memories" value={mem.memories} />
                          </div>
                        )}
                        {mem.emotions && (
                          <div>
                            <JsonDetails label="View emotions" value={mem.emotions} />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              </Panel>
              <ListPager pagination={pagination} noun={['entry', 'entries']} loading={loading} onChange={handlePageChange} />
            </>
      )}
    </div>
  );
}
