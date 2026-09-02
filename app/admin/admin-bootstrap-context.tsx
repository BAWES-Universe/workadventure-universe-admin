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
export type AdminBootstrap = { version: 1; user: AdminUser; stats: AdminStats };

const AdminBootstrapContext = createContext<AdminBootstrap | null>(null);

export function AdminBootstrapProvider({ value, children }: { value: AdminBootstrap; children: React.ReactNode }) {
  return <AdminBootstrapContext.Provider value={value}>{children}</AdminBootstrapContext.Provider>;
}

export function useAdminBootstrap(): AdminBootstrap {
  const value = useContext(AdminBootstrapContext);
  if (!value) throw new Error('useAdminBootstrap must be used inside AdminBootstrapProvider');
  return value;
}
