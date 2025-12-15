'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Loader2, AlertCircle, CheckCircle2, XCircle, Users, Mail } from 'lucide-react';

interface Invitation {
  id: string;
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
  invitedBy: {
    id: string;
    name: string | null;
    email: string | null;
  };
  invitedAt: string;
  tags: string[];
  message: string | null;
}

interface Membership {
  id: string;
  tags: string[];
  joinedAt: string;
  lastVisited: string | null;
  isUniverseOwner: boolean;
  world: {
    id: string;
    name: string;
    slug: string;
    universe: {
      id: string;
      name: string;
      slug: string;
      ownerId: string;
    };
  };
}

export default function MyMembershipsPage() {
  const router = useRouter();
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processingInvitation, setProcessingInvitation] = useState<string | null>(null);
  const [leavingWorld, setLeavingWorld] = useState<string | null>(null);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }
      fetchData();
    } catch (err) {
      router.push('/admin/login');
    }
  }

  async function fetchData() {
    try {
      setLoading(true);
      setError(null);
      const { authenticatedFetch } = await import('@/lib/client-auth');

      const [invitationsRes, membershipsRes] = await Promise.all([
        authenticatedFetch('/api/memberships/invitations'),
        authenticatedFetch('/api/memberships/my'),
      ]);

      if (!invitationsRes.ok) {
        throw new Error('Failed to fetch invitations');
      }
      if (!membershipsRes.ok) {
        throw new Error('Failed to fetch memberships');
      }

      const invitationsData = await invitationsRes.json();
      const membershipsData = await membershipsRes.json();

      setInvitations(invitationsData.invitations || []);
      setMemberships(membershipsData.memberships || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }

  async function handleAcceptInvitation(invitationId: string) {
    try {
      setProcessingInvitation(invitationId);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(
        `/api/memberships/invitations/${invitationId}/accept`,
        {
          method: 'POST',
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to accept invitation');
      }

      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept invitation');
    } finally {
      setProcessingInvitation(null);
    }
  }

  async function handleRejectInvitation(invitationId: string) {
    try {
      setProcessingInvitation(invitationId);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(
        `/api/memberships/invitations/${invitationId}/reject`,
        {
          method: 'POST',
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to reject invitation');
      }

      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject invitation');
    } finally {
      setProcessingInvitation(null);
    }
  }

  async function handleLeaveWorld(worldId: string) {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/memberships/my/world/${worldId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to leave world');
      }

      setLeavingWorld(null);
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to leave world');
      setLeavingWorld(null);
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

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-4xl font-bold tracking-tight">My Memberships</h1>
        <p className="text-muted-foreground text-lg">
          Manage your world memberships and invitations.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Pending Invitations */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Pending Invitations
          </CardTitle>
          <CardDescription>
            You have {invitations.length} pending invitation{invitations.length !== 1 ? 's' : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {invitations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending invitations.</p>
          ) : (
            <div className="space-y-4">
              {invitations.map((invitation) => (
                <Card key={invitation.id} className="border">
                  <CardContent className="pt-6">
                    <div className="flex items-start justify-between">
                      <div className="space-y-2 flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold">{invitation.world.name}</h3>
                          <Badge variant="outline">{invitation.world.universe.name}</Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          Invited by{' '}
                          {invitation.invitedBy.name ||
                            invitation.invitedBy.email ||
                            'Unknown'}{' '}
                          on {new Date(invitation.invitedAt).toLocaleDateString()}
                        </p>
                        {invitation.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {invitation.tags.map((tag) => (
                              <Badge key={tag} variant="secondary" className="capitalize">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        )}
                        {invitation.message && (
                          <p className="text-sm mt-2 italic text-muted-foreground">
                            "{invitation.message}"
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2 ml-4">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleRejectInvitation(invitation.id)}
                          disabled={processingInvitation === invitation.id}
                        >
                          {processingInvitation === invitation.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <>
                              <XCircle className="h-4 w-4 mr-1" />
                              Reject
                            </>
                          )}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleAcceptInvitation(invitation.id)}
                          disabled={processingInvitation === invitation.id}
                        >
                          {processingInvitation === invitation.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <>
                              <CheckCircle2 className="h-4 w-4 mr-1" />
                              Accept
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* My Memberships */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            My Memberships
          </CardTitle>
          <CardDescription>
            Worlds you are a member of
          </CardDescription>
        </CardHeader>
        <CardContent>
          {memberships.length === 0 ? (
            <p className="text-sm text-muted-foreground">You are not a member of any worlds.</p>
          ) : (
            <div className="space-y-4">
              {memberships.map((membership) => (
                <Card key={membership.id} className="border">
                  <CardContent className="pt-6">
                    <div className="flex items-start justify-between">
                      <div className="space-y-2 flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold">{membership.world.name}</h3>
                          <Badge variant="outline">{membership.world.universe.name}</Badge>
                          {membership.isUniverseOwner && (
                            <Badge variant="default">Owner</Badge>
                          )}
                        </div>
                        {membership.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {membership.tags.map((tag) => (
                              <Badge key={tag} variant="secondary" className="capitalize">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        )}
                        <div className="text-sm text-muted-foreground">
                          <div>Joined: {new Date(membership.joinedAt).toLocaleDateString()}</div>
                          {membership.lastVisited && (
                            <div>
                              Last visited: {new Date(membership.lastVisited).toLocaleDateString()}
                            </div>
                          )}
                        </div>
                        {membership.tags.includes('admin') && (
                          <div className="mt-2">
                            <Button size="sm" variant="outline" asChild>
                              <Link href={`/admin/worlds/${membership.world.id}`}>
                                Manage Members
                              </Link>
                            </Button>
                          </div>
                        )}
                      </div>
                      {!membership.isUniverseOwner && (
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => setLeavingWorld(membership.world.id)}
                        >
                          Leave
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Leave World Dialog */}
      <AlertDialog open={!!leavingWorld} onOpenChange={(open) => !open && setLeavingWorld(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave World</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to leave this world? You will lose access and need to be
              invited again to rejoin.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => leavingWorld && handleLeaveWorld(leavingWorld)}
            >
              Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

