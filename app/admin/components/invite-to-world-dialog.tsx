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
import { Loader2, AlertCircle, UserPlus } from 'lucide-react';
import { useToast } from '@/components/ui/toast';

interface World {
  id: string;
  name: string;
  slug: string;
  universe: {
    id: string;
    name: string;
    slug: string;
  };
}

interface InviteToWorldDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  onInviteSent: () => void;
}

const AVAILABLE_TAGS = ['admin', 'editor', 'member'];

export default function InviteToWorldDialog({
  open,
  onOpenChange,
  userId,
  onInviteSent,
}: InviteToWorldDialogProps) {
  const [worlds, setWorlds] = useState<World[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedWorldId, setSelectedWorldId] = useState<string>('');
  const [selectedTag, setSelectedTag] = useState<string>('member');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const { addToast } = useToast();

  useEffect(() => {
    if (open && userId) {
      fetchWorlds();
      setError(null);
    }
  }, [open, userId]);

  async function fetchWorlds() {
    try {
      setLoading(true);
      setError(null);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/users/${userId}/worlds`);
      if (!response.ok) {
        throw new Error('Failed to fetch worlds');
      }
      const data = await response.json();
      setWorlds(data.worlds || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load worlds');
    } finally {
      setLoading(false);
    }
  }

  async function handleInvite() {
    if (!selectedWorldId) return;

    try {
      setSending(true);
      setError(null);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/users/${userId}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          worldId: selectedWorldId,
          tags: [selectedTag],
          message: message || undefined,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to send invitation');
      }

      // Show toast and close immediately
      addToast({
        description: 'Invitation sent successfully!',
        variant: 'success',
      });
      
      // Reset form and close immediately
      setSelectedWorldId('');
      setSelectedTag('member');
      setMessage('');
      setError(null);
      setSending(false);
      onInviteSent();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send invitation');
      setSending(false);
    }
  }


  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-lg">
        <DialogHeader>
          <DialogTitle>Invite to World</DialogTitle>
          <DialogDescription>
            Select a world to invite this user to.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading || sending ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <Label htmlFor="world">World</Label>
              <Select value={selectedWorldId} onValueChange={setSelectedWorldId}>
                <SelectTrigger id="world" className="mt-1">
                  <SelectValue placeholder="Select a world" />
                </SelectTrigger>
                <SelectContent>
                  {worlds.length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">
                      No worlds available
                    </div>
                  ) : (
                    worlds.map((world) => (
                      <SelectItem key={world.id} value={world.id}>
                        {world.name} ({world.universe.name})
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            {selectedWorldId && (
              <>
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
                  <Label htmlFor="invite-message">Message (Optional)</Label>
                  <Textarea
                    id="invite-message"
                    rows={3}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Add a personal message to the invitation..."
                    className="mt-1"
                  />
                </div>
              </>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleInvite}
                disabled={sending || !selectedWorldId || !selectedTag}
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
        )}
      </DialogContent>
    </Dialog>
  );
}

