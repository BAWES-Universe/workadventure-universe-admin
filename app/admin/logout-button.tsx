'use client';

import { useState } from 'react';
import { authenticatedFetch, clearClientSession } from '@/lib/client-auth';

const LOGOUT_SUPPRESSION_KEY = 'orbit_auth_suppressed';

export default function LogoutButton() {
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
      onClick={handleLogout}
      disabled={loading}
      className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
    >
      {loading ? 'Logging out...' : 'Logout'}
    </button>
  );
}
