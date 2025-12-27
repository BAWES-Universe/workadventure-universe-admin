'use client';

import { useState, useEffect, useRef } from 'react';

interface User {
  id: string;
  name: string | null;
  email: string | null;
  isSuperAdmin?: boolean;
}

export function useUser(initialUser: User | null = null) {
  const [user, setUser] = useState<User | null>(initialUser);
  const hasFetchedRef = useRef(false);
  const lastInitialUserKeyRef = useRef<string | null>(null);

  // Create a stable key from initialUser for comparison
  const initialUserKey = initialUser 
    ? `${initialUser.id || ''}|${initialUser.name || ''}|${initialUser.email || ''}`
    : null;

  // Only fetch once on mount if we don't have an initial user
  useEffect(() => {
    if (hasFetchedRef.current) return;
    
    // If we have an initial user from server, use it and don't fetch
    if (initialUser) {
      hasFetchedRef.current = true;
      lastInitialUserKeyRef.current = initialUserKey;
      return;
    }

    // Otherwise, fetch once
    hasFetchedRef.current = true;
    async function fetchUser() {
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch('/api/auth/me');
        if (response.ok) {
          const data = await response.json();
          const fetchedUser = data.user ? {
            id: data.user.id,
            name: data.user.name,
            email: data.user.email,
            isSuperAdmin: data.user.isSuperAdmin || false,
          } : null;
          setUser(fetchedUser);
        } else {
          setUser(null);
        }
      } catch (error) {
        setUser(null);
      }
    }

    fetchUser();
  }, []); // Empty deps - only run once

  // Update state when initialUser actually changes (value-wise, not just reference)
  useEffect(() => {
    if (initialUserKey !== lastInitialUserKeyRef.current) {
      lastInitialUserKeyRef.current = initialUserKey;
      setUser(initialUser);
    }
  }, [initialUserKey, initialUser]);

  return { user };
}

