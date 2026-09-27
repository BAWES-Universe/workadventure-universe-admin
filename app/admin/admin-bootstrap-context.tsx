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
/** The person's own spaces: universes they own, worlds they belong to, rooms they starred, invitations waiting. */
export type AdminMine = { universes: number; worlds: number; stars: number; invitations: number };
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
