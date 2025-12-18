'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { Edit, Trash2, Loader2, X, UserCircle, Calendar, Clock, ChevronRight } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

interface Member {
  id: string;
  tags: string[];
  joinedAt: string;
  lastVisited: string | null;
  isUniverseOwner: boolean;
  user: {
    id: string;
    name: string | null;
    email: string | null;
  };
}

interface Invitation {
  id: string;
  tags: string[];
  invitedAt: string;
  invitedUser: {
    id: string;
    name: string | null;
    email: string | null;
  };
  invitedBy: {
    id: string;
    name: string | null;
    email: string | null;
  };
}

interface MemberListProps {
  worldId: string;
  onRefresh: () => void;
}

const AVAILABLE_TAGS = ['admin', 'editor', 'member'];

export default function MemberList({ worldId, onRefresh }: MemberListProps) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [editingMember, setEditingMember] = useState<Member | null>(null);
  const [editingTag, setEditingTag] = useState<string>('member');
  const [saving, setSaving] = useState(false);
  const [deletingMember, setDeletingMember] = useState<Member | null>(null);
  const [cancellingInvitation, setCancellingInvitation] = useState<string | null>(null);

  useEffect(() => {
    fetchData();
  }, [worldId]);

  async function fetchData() {
    try {
      setLoading(true);
      setError(null);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      const [membersRes, invitationsRes] = await Promise.all([
        authenticatedFetch(`/api/admin/worlds/${worldId}/members`),
        authenticatedFetch(`/api/admin/worlds/${worldId}/invitations`),
      ]);

      if (!membersRes.ok) {
        throw new Error('Failed to fetch members');
      }
      if (!invitationsRes.ok) {
        throw new Error('Failed to fetch invitations');
      }

      const membersData = await membersRes.json();
      const invitationsData = await invitationsRes.json();

      setMembers(membersData.members || []);
      setInvitations(invitationsData.invitations || []);
      // Use canManage from either response (they should both have it)
      setCanManage(membersData.canManage ?? invitationsData.canManage ?? false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }

  async function handleUpdateMember() {
    if (!editingMember) return;

    try {
      setSaving(true);
      setError(null);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(
        `/api/admin/worlds/${worldId}/members/${editingMember.id}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            tags: [editingTag],
          }),
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update member');
      }

      setEditingMember(null);
      setEditingTag('member');
      fetchData();
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update member');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteMember() {
    if (!deletingMember) return;

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(
        `/api/admin/worlds/${worldId}/members/${deletingMember.id}`,
        {
          method: 'DELETE',
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to remove member');
      }

      setDeletingMember(null);
      fetchData();
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
      setDeletingMember(null);
    }
  }

  async function handleCancelInvitation(invitationId: string) {
    try {
      setCancellingInvitation(invitationId);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(
        `/api/admin/worlds/${worldId}/invitations/cancel`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            invitationId,
          }),
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to cancel invitation');
      }

      fetchData();
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel invitation');
    } finally {
      setCancellingInvitation(null);
    }
  }


  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Active Members */}
      <div className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-xl font-semibold tracking-tight">Active Members</h3>
          <p className="text-sm text-muted-foreground">
            People who have access to this world
          </p>
        </div>
        {members.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              No members yet.
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {members.map((member) => {
              const nameOrEmail = member.user.name || member.user.email || 'Unknown';
              const initial = (member.user.name || member.user.email || '?').charAt(0).toUpperCase();
              const joinedDate = new Date(member.joinedAt).toLocaleDateString();
              const lastVisitedDate = member.lastVisited
                ? new Date(member.lastVisited).toLocaleDateString()
                : null;

              return (
                <div key={member.id} className="relative">
                  <Link
                    href={`/admin/users/${member.user.id}`}
                    className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <Card
                      className={cn(
                        'group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
                        'hover:-translate-y-1 hover:shadow-lg',
                      )}
                    >
                      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-secondary/20 opacity-0 transition-opacity group-hover:opacity-100" />

                      <div className="relative flex h-full flex-col p-5">
                        <div className="mb-3 flex items-start gap-3">
                          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border bg-muted text-sm font-semibold">
                            {initial}
                          </div>

                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-start justify-between gap-2">
                              <h3 className="truncate text-base font-semibold leading-tight">
                                {nameOrEmail}
                              </h3>
                            </div>
                            <p className="truncate text-xs text-muted-foreground">
                              {member.user.email || 'No email'}
                            </p>

                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                              {member.isUniverseOwner && (
                                <Badge variant="default">Owner</Badge>
                              )}
                              {member.tags.length > 0
                                ? member.tags.map((tag) => (
                                    <Badge
                                      key={tag}
                                      variant={
                                        tag === 'admin'
                                          ? 'destructive'
                                          : tag === 'editor'
                                            ? 'default'
                                            : 'secondary'
                                      }
                                      className="capitalize"
                                    >
                                      {tag}
                                    </Badge>
                                  ))
                                : !member.isUniverseOwner && (
                                    <Badge variant="secondary">Member</Badge>
                                  )}
                            </div>
                          </div>
                        </div>

                        <div className="mt-auto flex items-center justify-between pt-3 text-xs text-muted-foreground">
                          <div className="flex flex-col gap-1.5">
                            <div className="flex items-center gap-1.5">
                              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="text-muted-foreground">
                                Joined {joinedDate}
                              </span>
                            </div>
                            {lastVisitedDate && (
                              <div className="flex items-center gap-1.5">
                                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="text-muted-foreground">
                                  Last visited {lastVisitedDate}
                                </span>
                              </div>
                            )}
                            {!lastVisitedDate && (
                              <div className="flex items-center gap-1.5">
                                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="text-muted-foreground">Never visited</span>
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-1 text-primary transition-transform group-hover:translate-x-0.5">
                            <span className="hidden text-xs font-medium sm:inline">View</span>
                            <ChevronRight className="h-4 w-4" aria-hidden="true" />
                          </div>
                        </div>
                      </div>
                    </Card>
                  </Link>
                  {canManage && !member.isUniverseOwner && (
                    <div className="absolute top-2 right-2 z-10 flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 w-8 p-0"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setEditingMember(member);
                          setEditingTag(member.tags.length > 0 ? member.tags[0] : 'member');
                        }}
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-8 w-8 p-0"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setDeletingMember(member);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pending Invitations */}
      {(canManage || invitations.length > 0) && (
        <div className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-xl font-semibold tracking-tight">
              {canManage ? 'Pending Invitations' : 'Your Pending Invitations'}
            </h3>
            <p className="text-sm text-muted-foreground">
              Invitations waiting to be accepted
            </p>
          </div>
          {invitations.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                No pending invitations.
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {invitations.map((invitation) => {
                const invitedUserName =
                  invitation.invitedUser.name ||
                  invitation.invitedUser.email ||
                  'Unknown';
                const invitedUserInitial = (
                  invitation.invitedUser.name ||
                  invitation.invitedUser.email ||
                  '?'
                )
                  .charAt(0)
                  .toUpperCase();
                const invitedBy =
                  invitation.invitedBy.name ||
                  invitation.invitedBy.email ||
                  'Unknown';
                const invitedDate = new Date(invitation.invitedAt).toLocaleDateString();

                return (
                  <div key={invitation.id} className="relative">
                    <Link
                      href={`/admin/users/${invitation.invitedUser.id}`}
                      className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <Card
                        className={cn(
                          'group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
                          'hover:-translate-y-1 hover:shadow-lg',
                          'border-dashed',
                        )}
                      >
                        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-yellow-500/10 via-transparent to-orange-500/20 opacity-0 transition-opacity group-hover:opacity-100" />

                        <div className="relative flex h-full flex-col p-5">
                          <div className="mb-3 flex items-start gap-3">
                            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border bg-muted text-sm font-semibold">
                              {invitedUserInitial}
                            </div>

                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="flex items-start justify-between gap-2">
                                <h3 className="truncate text-base font-semibold leading-tight">
                                  {invitedUserName}
                                </h3>
                              </div>
                              <p className="truncate text-xs text-muted-foreground">
                                {invitation.invitedUser.email || 'No email'}
                              </p>

                              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                                {invitation.tags.map((tag) => (
                                  <Badge
                                    key={tag}
                                    variant={
                                      tag === 'admin'
                                        ? 'destructive'
                                        : tag === 'editor'
                                          ? 'default'
                                          : 'secondary'
                                    }
                                    className="capitalize"
                                  >
                                    {tag}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          </div>

                          <div className="mt-auto flex items-center justify-between pt-3 text-xs text-muted-foreground">
                            <div className="flex flex-col gap-1.5">
                              <div className="flex items-center gap-1.5">
                                <UserCircle className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="text-muted-foreground">
                                  Invited by {invitedBy}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="text-muted-foreground">
                                  Invited {invitedDate}
                                </span>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 text-primary transition-transform group-hover:translate-x-0.5">
                              <span className="hidden text-xs font-medium sm:inline">View</span>
                              <ChevronRight className="h-4 w-4" aria-hidden="true" />
                            </div>
                          </div>
                        </div>
                      </Card>
                    </Link>
                    {canManage && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="absolute top-2 right-2 z-10 h-8 w-8 p-0"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleCancelInvitation(invitation.id);
                        }}
                        disabled={cancellingInvitation === invitation.id}
                      >
                        {cancellingInvitation === invitation.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <X className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Edit Member Dialog */}
      <Dialog open={!!editingMember} onOpenChange={(open) => !open && setEditingMember(null)}>
        <DialogContent className="rounded-lg">
          <DialogHeader>
            <DialogTitle>Edit Member</DialogTitle>
            <DialogDescription>
              Update tags for {editingMember?.user.name || editingMember?.user.email || 'this member'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="edit-role">Role</Label>
              <Select value={editingTag} onValueChange={setEditingTag}>
                <SelectTrigger id="edit-role" className="mt-1">
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {AVAILABLE_TAGS.map(tag => (
                    <SelectItem key={tag} value={tag}>
                      <span className="capitalize">{tag}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setEditingMember(null);
                  setEditingTag('member');
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleUpdateMember}
                disabled={saving || !editingTag}
              >
                {saving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Save Changes'
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Member Dialog */}
      <AlertDialog open={!!deletingMember} onOpenChange={(open) => !open && setDeletingMember(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Member</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove{' '}
              {deletingMember?.user.name || deletingMember?.user.email || 'this member'}? They will
              lose access to this world.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleDeleteMember}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

