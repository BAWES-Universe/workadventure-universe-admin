'use client';

import { useState, useEffect } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import { Edit, Trash2, Loader2, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import Link from 'next/link';

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
      <div>
        <h3 className="text-lg font-semibold mb-4">Active Members</h3>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No members yet.</p>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead>Last Visited</TableHead>
                  {canManage && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/admin/users/${member.user.id}`}
                        className="text-primary hover:underline"
                      >
                        {member.user.name || member.user.email || 'Unknown'}
                      </Link>
                      {member.isUniverseOwner && (
                        <Badge variant="outline" className="ml-2">Owner</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {member.tags.length > 0 ? (
                          member.tags.map((tag) => (
                            <Badge key={tag} variant="secondary" className="capitalize">
                              {tag}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-sm text-muted-foreground">No tags</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(member.joinedAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {member.lastVisited
                        ? new Date(member.lastVisited).toLocaleDateString()
                        : 'Never'}
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setEditingMember(member);
                              // Use first tag or default to 'member'
                              setEditingTag(member.tags.length > 0 ? member.tags[0] : 'member');
                            }}
                            disabled={member.isUniverseOwner}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => setDeletingMember(member)}
                            disabled={member.isUniverseOwner}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Pending Invitations */}
      {(canManage || invitations.length > 0) && (
        <div>
          <h3 className="text-lg font-semibold mb-4">
            {canManage ? 'Pending Invitations' : 'Your Pending Invitations'}
          </h3>
          {invitations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending invitations.</p>
          ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invited User</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Invited By</TableHead>
                  <TableHead>Invited</TableHead>
                  {canManage && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitations.map((invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/admin/users/${invitation.invitedUser.id}`}
                        className="text-primary hover:underline"
                      >
                        {invitation.invitedUser.name ||
                          invitation.invitedUser.email ||
                          'Unknown'}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {invitation.tags.map((tag) => (
                          <Badge key={tag} variant="secondary" className="capitalize">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {invitation.invitedBy.name ||
                        invitation.invitedBy.email ||
                        'Unknown'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(invitation.invitedAt).toLocaleDateString()}
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleCancelInvitation(invitation.id)}
                          disabled={cancellingInvitation === invitation.id}
                        >
                          {cancellingInvitation === invitation.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <X className="h-4 w-4" />
                          )}
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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

