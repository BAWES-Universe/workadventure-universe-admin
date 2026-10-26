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
export type AdminBootstrap = {
  version: 1;
  user: AdminUser;
  stats: AdminStats;
  /** The layers of your Woka as image URLs, bottom first; absent from an older server, empty when it could not be read. */
  woka?: string[];
  mine?: AdminMine;
  /** START_ROOM_URL as `@/universe/world/room`; null when it is a map URL; absent from an older server. */
  startRoom?: string | null;
};

const AdminBootstrapContext = createContext<AdminBootstrap | null>(null);
const BootstrapFreshContext = createContext(true);

/** `fresh` is false while the numbers are from an earlier load and newer ones are on the way. */
export function AdminBootstrapProvider({ value, fresh = true, children }: { value: AdminBootstrap; fresh?: boolean; children: React.ReactNode }) {
  return (
    <AdminBootstrapContext.Provider value={value}>
      <BootstrapFreshContext.Provider value={fresh}>{children}</BootstrapFreshContext.Provider>
    </AdminBootstrapContext.Provider>
  );
}

/** Whether `mine` and the other numbers are this visit's, not left from an earlier page while new ones load. */
export function useBootstrapFresh(): boolean {
  return useContext(BootstrapFreshContext);
}

export function useAdminBootstrap(): AdminBootstrap {
  const value = useContext(AdminBootstrapContext);
  if (!value) throw new Error('useAdminBootstrap must be used inside AdminBootstrapProvider');
  return value;
}

/** Where everyone lands, as `@/universe/world/room`; the built-in default outside the shell or from an older server. */
export function useStartRoom(): string | null {
  const startRoom = useContext(AdminBootstrapContext)?.startRoom;
  return startRoom === undefined ? '@/default/default/default' : startRoom;
}

/** Whether the signed-in person is a super admin; false outside the shell (a test, a sign-in page). */
export function useIsSuperAdmin(): boolean {
  return useContext(AdminBootstrapContext)?.user.isSuperAdmin === true;
}

/**
 * Your Woka as the shell knows it (image URLs, bottom first): loaded once with the shell and kept across pages, so a page
 * draws it at once instead of asking again. Empty outside the shell or when the server could not say.
 */
export function useMyWoka(): string[] {
  return useContext(AdminBootstrapContext)?.woka ?? NO_WOKA;
}

const NO_WOKA: string[] = [];
