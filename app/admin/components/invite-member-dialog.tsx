'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Loader2, AlertCircle, UserPlus } from 'lucide-react';

interface Visitor {
  id: string;
  name: string | null;
  email: string | null;
  lastVisited: string;
  isMember: boolean;
  hasPendingInvitation: boolean;
}

interface InviteMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  worldId: string;
  onInviteSent: () => void;
}

const AVAILABLE_TAGS = ['admin', 'editor', 'member'];

export default function InviteMemberDialog({
  open,
  onOpenChange,
  worldId,
  onInviteSent,
}: InviteMemberDialogProps) {
  const [visitors, setVisitors] = useState<Visitor[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string>('member');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (open && worldId) {
      fetchVisitors();
    }
  }, [open, worldId]);

  async function fetchVisitors() {
    try {
      setLoading(true);
      setError(null);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/worlds/${worldId}/visitors`);
      if (!response.ok) {
        throw new Error('Failed to fetch visitors');
      }
      const data = await response.json();
      setVisitors(data.visitors || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load visitors');
    } finally {
      setLoading(false);
    }
  }

  async function handleInvite(userId: string) {
    try {
      setSending(true);
      setError(null);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/worlds/${worldId}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId,
          tags: [selectedTag],
          message: message || undefined,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to send invitation');
      }

      // Reset form
      setSelectedUserId(null);
      setSelectedTag('member');
      setMessage('');
      onInviteSent();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send invitation');
    } finally {
      setSending(false);
    }
  }


  const selectedVisitor = selectedUserId
    ? visitors.find(v => v.id === selectedUserId)
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Invite Member</DialogTitle>
          <DialogDescription>
            Select a recent visitor to invite them to this world.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : selectedUserId && selectedVisitor ? (
          <div className="space-y-4">
            <div>
              <Label>Inviting</Label>
              <div className="mt-1 p-3 bg-muted rounded-md">
                <div className="font-medium">{selectedVisitor.name || 'Unknown'}</div>
                {selectedVisitor.email && (
                  <div className="text-sm text-muted-foreground">{selectedVisitor.email}</div>
                )}
              </div>
            </div>

            <div>
              <Label htmlFor="role">Role</Label>
              <Select value={selectedTag} onValueChange={setSelectedTag}>
                <SelectTrigger id="role" className="mt-1">
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

            <div>
              <Label htmlFor="message">Message (Optional)</Label>
              <Textarea
                id="message"
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Add a personal message to the invitation..."
                className="mt-1"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setSelectedUserId(null);
                  setSelectedTag('member');
                  setMessage('');
                }}
              >
                Back
              </Button>
              <Button
                onClick={() => handleInvite(selectedUserId)}
                disabled={sending || !selectedTag}
              >
                {sending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <UserPlus className="mr-2 h-4 w-4" />
                    Send Invitation
                  </>
                )}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {visitors.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No recent visitors found. Users must visit this world before they can be invited.
              </div>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Last Visited</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visitors.map((visitor) => (
                      <TableRow key={visitor.id}>
                        <TableCell className="font-medium">
                          {visitor.name || 'Unknown'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {visitor.email || '-'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {new Date(visitor.lastVisited).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-right">
                          {visitor.isMember ? (
                            <span className="text-sm text-muted-foreground">Already a member</span>
                          ) : visitor.hasPendingInvitation ? (
                            <span className="text-sm text-muted-foreground">Invitation pending</span>
                          ) : (
                            <Button
                              size="sm"
                              onClick={() => setSelectedUserId(visitor.id)}
                            >
                              Invite
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

