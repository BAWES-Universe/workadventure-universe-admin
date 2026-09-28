'use client';

import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { authenticatedFetch, clearClientSession } from '@/lib/client-auth';
import { cn } from '@/lib/utils';

const LOGOUT_SUPPRESSION_KEY = 'orbit_auth_suppressed';

/** Signs out of Orbit (the game session stays as it is). */
export default function LogoutButton({ className }: { className?: string }) {
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    try {
      await authenticatedFetch('/api/auth/logout', { method: 'POST' });
    } catch (error) {
      console.error('Logout error:', error);
      // Local logout still succeeds if server revocation is temporarily unavailable.
    } finally {
      clearClientSession();
      sessionStorage.setItem(LOGOUT_SUPPRESSION_KEY, 'true');
      setLoading(false);
      window.location.replace('/admin/login');
    }
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={loading}
      className={cn(
        'orbit-press inline-flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50',
        className,
      )}
    >
      <LogOut className="h-4 w-4" aria-hidden="true" />
      {loading ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
