import { LayoutDashboard, Globe, Users, UserCircle, Mail, Compass, Home, FolderOpen } from 'lucide-react';
import { LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  requiresAuth?: boolean;
  group?: 'menu' | 'discover' | 'my';
}

export const NAV_ITEMS: NavItem[] = [
  // Primary dashboard entry (no group, always at top)
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },

  // Discover section
  { href: '/admin/discover/universes', label: 'Universes', icon: Compass, group: 'discover' },
  { href: '/admin/discover/worlds', label: 'Worlds', icon: Home, group: 'discover' },
  { href: '/admin/discover/rooms', label: 'Rooms', icon: FolderOpen, group: 'discover' },
  { href: '/admin/users', label: 'Users', icon: Users, group: 'discover' },

  // Personalize section
  { href: '/admin/universes', label: 'Universes', icon: Globe, group: 'my' },
  { href: '/admin/memberships', label: 'Memberships', icon: Mail, requiresAuth: true, group: 'my' },
  { href: '/admin/profile', label: 'Visit Card', icon: UserCircle, requiresAuth: true, group: 'my' },
];

export function getNavItems(user: { name: string | null; email: string | null } | null): NavItem[] {
  return NAV_ITEMS.filter(item => !item.requiresAuth || user !== null);
}

