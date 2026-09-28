'use client';

import { createContext, useContext } from 'react';

export type AdminUser = {
  id: string;
  uuid: string;
  name: string | null;
  email: string | null;
  tags: string[];
  isSuperAdmin: boolean;
};

export type AdminStats = { universes: number; worlds: number; rooms: number; users: number };
/** The person's own space: universes they own, worlds they belong to, rooms they starred, invitations waiting. */
export type AdminMine = {
  universes: number;
  worlds: number;
  stars: number;
  invitations: number;
  /** Worlds in universes you own; absent from an older server. */
  ownedWorlds?: number;
  /** Invitations you've sent, whatever the answer; absent from an older server. */
  invitationsSent?: number;
};
export type AdminBootstrap = { version: 1; user: AdminUser; stats: AdminStats; mine?: AdminMine };

const AdminBootstrapContext = createContext<AdminBootstrap | null>(null);

export function AdminBootstrapProvider({ value, children }: { value: AdminBootstrap; children: React.ReactNode }) {
  return <AdminBootstrapContext.Provider value={value}>{children}</AdminBootstrapContext.Provider>;
}

export function useAdminBootstrap(): AdminBootstrap {
  const value = useContext(AdminBootstrapContext);
  if (!value) throw new Error('useAdminBootstrap must be used inside AdminBootstrapProvider');
  return value;
}

/** Whether the signed-in person is a super admin; false outside the shell (a test, a sign-in page). */
export function useIsSuperAdmin(): boolean {
  return useContext(AdminBootstrapContext)?.user.isSuperAdmin === true;
}
