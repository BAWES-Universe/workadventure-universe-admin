'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RoleChoice } from './role-choice';
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
import { Loader2, Pencil, Trash2, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import { timeAgo } from '@/lib/time-ago';
import { EmptyCard, EntityRow, LoadingRows, RolePills, SectionHeader, StatLine } from './ds';


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
    return <LoadingRows label="members" rows={3} />;
  }

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {members.length === 0 ? (
        <EmptyCard kind="people" title="No members yet." text="Invite people to give them a role in this world." />
      ) : (
        <div>
          {members.map((member) => {
            const nameOrEmail = member.user.name || member.user.email || 'Unknown';
            const roles = [
              ...(member.isUniverseOwner ? ['owner'] : []),
              ...(member.tags.length > 0 ? member.tags : member.isUniverseOwner ? [] : ['member']),
            ];
            return (
              <EntityRow
                key={member.id}
                href={`/admin/users/${member.user.id}`}
                kind="people"
                title={nameOrEmail}
                context={
                  <StatLine
                    items={[
                      member.user.name ? member.user.email : null,
                      `Joined ${new Date(member.joinedAt).toLocaleDateString()}`,
                      member.lastVisited ? `Last visited ${timeAgo(new Date(member.lastVisited))}` : 'Never visited',
                    ]}
                  />
                }
                meta={<RolePills roles={roles} />}
                trailing={
                  canManage && !member.isUniverseOwner ? (
                    <>
                      <Button
                        size="icon"
                        variant="outline"
                        className="h-9 w-9"
                        aria-label={`Change ${nameOrEmail}'s role`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setEditingMember(member);
                          setEditingTag(member.tags.length > 0 ? member.tags[0] : 'member');
                        }}
                      >
                        <Pencil aria-hidden="true" />
                      </Button>
                      <Button
                        size="icon"
                        variant="destructive"
                        className="h-9 w-9"
                        aria-label={`Remove ${nameOrEmail}`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setDeletingMember(member);
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </>
                  ) : undefined
                }
              />
            );
          })}
        </div>
      )}

      {(canManage || invitations.length > 0) && (
        <section aria-labelledby="pending-invitations">
          <SectionHeader
            id="pending-invitations"
            title={canManage ? 'Pending invitations' : 'Your pending invitations'}
            count={invitations.length}
          />
          {invitations.length === 0 ? (
            <EmptyCard kind="people" title="No pending invitations." text="People you invite show up here until they accept." />
          ) : (
            <div>
              {invitations.map((invitation) => {
                const invitedUserName = invitation.invitedUser.name || invitation.invitedUser.email || 'Unknown';
                const invitedBy = invitation.invitedBy.name || invitation.invitedBy.email || 'Unknown';
                return (
                  <EntityRow
                    key={invitation.id}
                    href={`/admin/users/${invitation.invitedUser.id}`}
                    kind="people"
                    title={invitedUserName}
                    context={
                      <StatLine
                        items={[
                          invitation.invitedUser.name ? invitation.invitedUser.email : null,
                          `Invited by ${invitedBy}`,
                          new Date(invitation.invitedAt).toLocaleDateString(),
                        ]}
                      />
                    }
                    meta={invitation.tags.length > 0 ? <RolePills roles={invitation.tags} /> : undefined}
                    trailing={
                      canManage ? (
                        <Button
                          size="icon"
                          variant="outline"
                          className="h-9 w-9"
                          aria-label={`Cancel the invitation to ${invitedUserName}`}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleCancelInvitation(invitation.id);
                          }}
                          disabled={cancellingInvitation === invitation.id}
                        >
                          {cancellingInvitation === invitation.id ? (
                            <Loader2 className="animate-spin" aria-hidden="true" />
                          ) : (
                            <X aria-hidden="true" />
                          )}
                        </Button>
                      ) : undefined
                    }
                  />
                );
              })}
            </div>
          )}
        </section>
      )}
      {/* Edit Member Dialog */}
      <Dialog open={!!editingMember} onOpenChange={(open) => !open && setEditingMember(null)}>
        <DialogContent className="rounded-lg">
          <DialogHeader>
            <DialogTitle>Change role</DialogTitle>
            <DialogDescription>
              Choose a role for {editingMember?.user.name || editingMember?.user.email || 'this member'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label id="edit-role-label">Role</Label>
              <RoleChoice value={editingTag} onChange={setEditingTag} name="edit-role" labelledBy="edit-role-label" />
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
                  'Save changes'
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
            <AlertDialogTitle>Remove member</AlertDialogTitle>
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

