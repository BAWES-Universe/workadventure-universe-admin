'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function LogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    try {
      // Clear localStorage session data
      localStorage.removeItem('admin_session_id');
      localStorage.removeItem('admin_session_token'); // Legacy
      localStorage.removeItem('admin_session_expires'); // Legacy
      
      // Call logout API to clear server-side session
      await fetch('/api/auth/logout', {
        method: 'POST',
      });
      
      // Redirect to login
      router.push('/admin/login');
      router.refresh();
    } catch (error) {
      console.error('Logout error:', error);
      // Still redirect even if API call fails
      localStorage.removeItem('admin_session_id');
      localStorage.removeItem('admin_session_token'); // Legacy
      localStorage.removeItem('admin_session_expires'); // Legacy
      router.push('/admin/login');
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleLogout}
      disabled={loading}
      className="text-sm text-gray-600 hover:text-gray-900 disabled:opacity-50"
    >
      {loading ? 'Logging out...' : 'Logout'}
    </button>
  );
}

