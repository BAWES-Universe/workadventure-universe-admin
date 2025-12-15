'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ChevronRight, AlertCircle, Loader2, Globe, Users, Star, Ban, UserPlus } from 'lucide-react';
import InviteToWorldDialog from '../components/invite-to-world-dialog';

interface WorldMembership {
  id: string;
  tags: string[];
  joinedAt: string;
  world: {
    id: string;
    slug: string;
    name: string;
    universe: {
      id: string;
      slug: string;
      name: string;
    };
  };
}

interface Universe {
  id: string;
  slug: string;
  name: string;
  isPublic: boolean;
  createdAt: string;
}

interface User {
  id: string;
  uuid: string;
  name: string | null;
  email: string | null;
  matrixChatId: string | null;
  lastIpAddress: string | null;
  isGuest: boolean;
  createdAt: string;
  updatedAt: string;
  ownedUniverses: Universe[];
  worldMemberships: WorldMembership[];
  _count: {
    ownedUniverses: number;
    worldMemberships: number;
    bans: number;
    favorites: number;
    avatars: number;
  };
}

export default function UserDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accessHistory, setAccessHistory] = useState<any>(null);
  const [accessHistoryLoading, setAccessHistoryLoading] = useState(true);
  const [accessHistoryPage, setAccessHistoryPage] = useState(1);
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);

  useEffect(() => {
    checkAuth();
    fetchUser();
    fetchAccessHistory();
  }, [id, accessHistoryPage]);

  async function checkAuth() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }
      const data = await response.json();
      setCurrentUser(data.user);
      setIsSuperAdmin(data.user?.isSuperAdmin || false);
    } catch (err) {
      router.push('/admin/login');
    }
  }

  async function fetchUser() {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/users/${id}`);

      if (!response.ok) {
        if (response.status === 404) {
          router.push('/admin/users');
          return;
        }
        throw new Error('Failed to fetch user');
      }

      const data = await response.json();
      setUser(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load user');
    } finally {
      setLoading(false);
    }
  }

  async function fetchAccessHistory() {
    try {
      setAccessHistoryLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/analytics/users/${id}?page=${accessHistoryPage}&limit=20`);

      if (!response.ok) {
        throw new Error('Failed to fetch access history');
      }

      const data = await response.json();
      setAccessHistory(data);
    } catch (err) {
      console.error('Failed to fetch access history:', err);
    } finally {
      setAccessHistoryLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="space-y-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Not Found</AlertTitle>
          <AlertDescription>User not found</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <nav className="flex items-center space-x-2 text-sm text-muted-foreground">
        <Link href="/admin" className="hover:text-foreground">
          Dashboard
        </Link>
        <ChevronRight className="h-4 w-4" />
        <Link href="/admin/users" className="hover:text-foreground">
          Users
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground">{user.name || user.email || 'User'}</span>
      </nav>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-4xl font-bold tracking-tight">{user.name || user.email || 'Unknown User'}</h1>
          <p className="text-muted-foreground">
            UUID: <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-xs">{user.uuid}</code>
          </p>
        </div>
        <Button onClick={() => setInviteDialogOpen(true)}>
          <UserPlus className="mr-2 h-4 w-4" />
          Invite to World
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>User Information</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Name</dt>
              <dd className="mt-1 text-sm">{user.name || 'N/A'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Email</dt>
              <dd className="mt-1 text-sm">{user.email || 'N/A'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Status</dt>
              <dd className="mt-1">
                {user.isGuest ? (
                  <Badge variant="outline">Guest</Badge>
                ) : (
                  <Badge>Authenticated</Badge>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Matrix Chat ID</dt>
              <dd className="mt-1 text-sm font-mono text-xs">{user.matrixChatId || 'N/A'}</dd>
            </div>
            {isSuperAdmin && (
              <div>
                <dt className="text-sm font-medium text-muted-foreground">Last IP Address</dt>
                <dd className="mt-1 text-sm font-mono text-xs">{user.lastIpAddress || 'N/A'}</dd>
              </div>
            )}
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Created</dt>
              <dd className="mt-1 text-sm">{new Date(user.createdAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Last Updated</dt>
              <dd className="mt-1 text-sm">{new Date(user.updatedAt).toLocaleString()}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <Globe className="h-8 w-8 text-muted-foreground" />
              </div>
              <div className="ml-4 flex-1">
                <p className="text-sm font-medium text-muted-foreground">Owned Universes</p>
                <p className="text-2xl font-semibold">{user._count.ownedUniverses}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <Users className="h-8 w-8 text-muted-foreground" />
              </div>
              <div className="ml-4 flex-1">
                <p className="text-sm font-medium text-muted-foreground">World Memberships</p>
                <p className="text-2xl font-semibold">{user._count.worldMemberships}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <Star className="h-8 w-8 text-muted-foreground" />
              </div>
              <div className="ml-4 flex-1">
                <p className="text-sm font-medium text-muted-foreground">Favorites</p>
                <p className="text-2xl font-semibold">{user._count.favorites}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <Ban className="h-8 w-8 text-muted-foreground" />
              </div>
              <div className="ml-4 flex-1">
                <p className="text-sm font-medium text-muted-foreground">Bans</p>
                <p className="text-2xl font-semibold">{user._count.bans}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {user.ownedUniverses.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Owned Universes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {user.ownedUniverses.map((universe) => (
                <Link
                  key={universe.id}
                  href={`/admin/universes/${universe.id}`}
                  className="block p-3 border rounded-lg hover:bg-accent transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{universe.name}</p>
                      <p className="text-sm text-muted-foreground">
                        Slug: <code className="bg-muted px-1 rounded">{universe.slug}</code>
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={universe.isPublic ? 'default' : 'secondary'}>
                        {universe.isPublic ? 'Public' : 'Private'}
                      </Badge>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {user.worldMemberships.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>World Memberships</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {user.worldMemberships.map((membership) => (
                <Link
                  key={membership.id}
                  href={`/admin/worlds/${membership.world.id}`}
                  className="block p-3 border rounded-lg hover:bg-accent transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{membership.world.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {membership.world.universe.name} / {membership.world.name}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Joined: {new Date(membership.joinedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {membership.tags.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {membership.tags.map((tag) => (
                            <Badge
                              key={tag}
                              variant={tag === 'admin' ? 'destructive' : tag === 'editor' ? 'default' : 'secondary'}
                            >
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">No tags</span>
                      )}
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {user.ownedUniverses.length === 0 && user.worldMemberships.length === 0 && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground text-center">
              This user doesn't own any universes or have any world memberships.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Access History</CardTitle>
          {accessHistory && (
            <CardDescription>
              {accessHistory.total} total accesses
              {accessHistory.firstAccess && (
                <> • First: {new Date(accessHistory.firstAccess).toLocaleDateString()}</>
              )}
              {accessHistory.lastAccess && (
                <> • Last: {new Date(accessHistory.lastAccess).toLocaleDateString()}</>
              )}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {accessHistoryLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : accessHistory && accessHistory.accesses.length > 0 ? (
            <div className="space-y-4">
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Universe / World / Room</TableHead>
                      {isSuperAdmin && <TableHead>IP Address</TableHead>}
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accessHistory.accesses.map((access: any) => (
                      <TableRow key={access.id}>
                        <TableCell className="text-sm">
                          {new Date(access.accessedAt).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-sm">
                          <div className="flex flex-wrap items-center gap-1">
                            <Link
                              href={`/admin/universes/${access.universe.id}`}
                              className="text-primary hover:underline"
                            >
                              {access.universe.name}
                            </Link>
                            <span className="text-muted-foreground">/</span>
                            <Link
                              href={`/admin/worlds/${access.world.id}`}
                              className="text-primary hover:underline"
                            >
                              {access.world.name}
                            </Link>
                            <span className="text-muted-foreground">/</span>
                            <Link
                              href={`/admin/rooms/${access.room.id}`}
                              className="text-primary hover:underline"
                            >
                              {access.room.name}
                            </Link>
                          </div>
                        </TableCell>
                        {isSuperAdmin && (
                          <TableCell className="text-sm font-mono text-muted-foreground">
                            {access.ipAddress}
                          </TableCell>
                        )}
                        <TableCell>
                          {access.hasMembership && access.membershipTags.length > 0 ? (
                            <Badge variant="outline">{access.membershipTags.join(', ')}</Badge>
                          ) : access.isAuthenticated ? (
                            <Badge>Authenticated</Badge>
                          ) : (
                            <Badge variant="secondary">Guest</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {accessHistory.totalPages > 1 && (
                <div className="flex items-center justify-between">
                  <Button
                    variant="outline"
                    onClick={() => setAccessHistoryPage(p => Math.max(1, p - 1))}
                    disabled={accessHistoryPage === 1}
                  >
                    Previous
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Page {accessHistoryPage} of {accessHistory.totalPages}
                  </span>
                  <Button
                    variant="outline"
                    onClick={() => setAccessHistoryPage(p => Math.min(accessHistory.totalPages, p + 1))}
                    disabled={accessHistoryPage >= accessHistory.totalPages}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-12">No access history found.</p>
          )}
        </CardContent>
      </Card>

      <InviteToWorldDialog
        open={inviteDialogOpen}
        onOpenChange={setInviteDialogOpen}
        userId={id}
        onInviteSent={() => {
          fetchUser();
        }}
      />
    </div>
  );
}
