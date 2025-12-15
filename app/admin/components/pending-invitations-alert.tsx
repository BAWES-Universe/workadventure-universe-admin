'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { X, Mail } from 'lucide-react';

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
}

export default function PendingInvitationsAlert() {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    fetchInvitations();
  }, []);

  async function fetchInvitations() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/memberships/invitations');
      if (response.ok) {
        const data = await response.json();
        setInvitations(data.invitations || []);
      }
    } catch (error) {
      console.error('Error fetching invitations:', error);
    } finally {
      setLoading(false);
    }
  }

  if (loading || dismissed || invitations.length === 0) {
    return null;
  }

  const inviterName = invitations[0].invitedBy.name || invitations[0].invitedBy.email || 'Someone';

  return (
    <Alert className="mb-6 border-blue-200 bg-blue-50 dark:bg-blue-950 dark:border-blue-800">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3 flex-1">
          <Mail className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5" />
          <div className="flex-1">
            <AlertTitle className="text-blue-800 dark:text-blue-200">
              You have {invitations.length} pending membership invitation{invitations.length > 1 ? 's' : ''}
            </AlertTitle>
            <AlertDescription className="text-blue-700 dark:text-blue-300 mt-1">
              {invitations.length === 1 ? (
                <>
                  {inviterName} invited you to join <strong>{invitations[0].world.name}</strong> in {invitations[0].world.universe.name}
                </>
              ) : (
                <>
                  You have {invitations.length} pending invitations to join worlds
                </>
              )}
            </AlertDescription>
            <div className="mt-3">
              <Button asChild variant="default" size="sm">
                <Link href="/admin/memberships">
                  View Invitations
                </Link>
              </Button>
            </div>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200"
          onClick={() => setDismissed(true)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </Alert>
  );
}

