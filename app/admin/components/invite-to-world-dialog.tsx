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
import { cn } from '@/lib/utils';
import { BUILT_IN_ROLES } from '../invitations/invitation-role';

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
  /** Who is being invited, for the title and the toast. */
  userName?: string;
  onInviteSent: () => void;
}

/** Member first: the usual answer, and the one that gives the least. */
const ROLE_CHOICES = [...BUILT_IN_ROLES].reverse();

export default function InviteToWorldDialog({
  open,
  onOpenChange,
  userId,
  userName,
  onInviteSent,
}: InviteToWorldDialogProps) {
  const who = userName || 'this person';
  const [worlds, setWorlds] = useState<World[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedWorldId, setSelectedWorldId] = useState<string>('');
  const [selectedTag, setSelectedTag] = useState<string>('member');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const { addToast } = useToast();
  const selectedWorld = worlds.find((world) => world.id === selectedWorldId);

  useEffect(() => {
    if (open && userId) {
      // Each open starts blank: a cancelled invite doesn't come back.
      setSelectedWorldId('');
      setSelectedTag('member');
      setMessage('');
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
        description: `Invitation sent to ${who}.`,
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
          <DialogTitle>Invite {who} to become a member</DialogTitle>
          <DialogDescription>
            Members can enter the world’s members-only rooms. Public rooms are open to everyone, no invitation needed.
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
                  <SelectValue placeholder="Pick a world" />
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
                <fieldset>
                  <legend className="text-sm font-medium">As</legend>
                  <div className="mt-1 grid gap-2" role="radiogroup">
                    {ROLE_CHOICES.map((role) => {
                      const picked = selectedTag === role.tag;
                      return (
                        <button
                          key={role.tag}
                          type="button"
                          role="radio"
                          aria-checked={picked}
                          onClick={() => setSelectedTag(role.tag)}
                          className={cn(
                            'flex items-start gap-3 rounded-2xl border p-3 text-left transition-colors',
                            picked ? 'border-[#8629fc] bg-[#8629fc]/10' : 'border-foreground/15 hover:border-foreground/30 hover:bg-foreground/5',
                          )}
                        >
                          <span
                            className={cn(
                              'mt-0.5 grid h-4 w-4 flex-none place-items-center rounded-full border',
                              picked ? 'border-[#8629fc]' : 'border-foreground/40',
                            )}
                            aria-hidden="true"
                          >
                            {picked && <span className="h-2 w-2 rounded-full bg-[image:var(--brand-gradient)]" />}
                          </span>
                          <span>
                            <span className="block text-sm font-semibold capitalize">{role.tag}</span>
                            <span className="block text-[13px] text-muted-foreground">Can {role.can}.</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>

                <div>
                  <Label htmlFor="invite-message">Message (optional)</Label>
                  <Textarea
                    id="invite-message"
                    rows={3}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Say why you’re inviting them"
                    className="mt-1"
                  />
                </div>
              </>
            )}

            {selectedWorld && (
              <p className="text-sm text-muted-foreground" data-testid="invite-summary">
                {who} gets an invitation and becomes {selectedTag === 'admin' ? 'an Admin' : selectedTag === 'editor' ? 'an Editor' : 'a Member'}{' '}
                of {selectedWorld.name} once they accept.
              </p>
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
                    Sending…
                  </>
                ) : (
                  <>
                    <UserPlus className="mr-2 h-4 w-4" />
                    Send invitation
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

