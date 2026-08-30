'use client';

import { useState } from 'react';
import { authenticatedFetch, clearClientSession } from '@/lib/client-auth';

export default function LogoutButton() {
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    try {
      await authenticatedFetch('/api/auth/logout', {
        method: 'POST',
      });
      clearClientSession();
      sessionStorage.setItem('orbit_auth_suppressed', 'true');
      window.location.replace('/admin/login');
    } catch (error) {
      console.error('Logout error:', error);
      // Still redirect even if API call fails
      clearClientSession();
      sessionStorage.setItem('orbit_auth_suppressed', 'true');
      window.location.replace('/admin/login');
    } finally {
      setLoading(false);
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
