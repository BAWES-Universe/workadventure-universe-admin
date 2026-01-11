import { LayoutDashboard, Globe, Users, UserCircle, Mail, Compass, Home, FolderOpen, Star, Shield, Bot, BarChart3 } from 'lucide-react';
import { LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  requiresAuth?: boolean;
  requiresSuperAdmin?: boolean;
  group?: 'menu' | 'discover' | 'my' | 'admin';
}

export const NAV_ITEMS: NavItem[] = [
  // Primary dashboard entry (no group, always at top)
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },

  // Room Templates - available to all users
  { href: '/admin/templates', label: 'Room Templates', icon: FolderOpen },

  // Personalize section
  { href: '/admin/universes', label: 'My Universes', icon: Globe, group: 'my' },
  { href: '/admin/stars', label: 'My Stars', icon: Star, group: 'my' },
  { href: '/admin/memberships', label: 'My Memberships', icon: Mail, requiresAuth: true, group: 'my' },
  { href: '/admin/profile', label: 'My Visit Card', icon: UserCircle, requiresAuth: true, group: 'my' },

  // Discover section
  { href: '/admin/discover/universes', label: 'Universes', icon: Compass, group: 'discover' },
  { href: '/admin/discover/worlds', label: 'Worlds', icon: Home, group: 'discover' },
  { href: '/admin/discover/rooms', label: 'Rooms', icon: FolderOpen, group: 'discover' },
  { href: '/admin/users', label: 'Users', icon: Users, group: 'discover' },

  // Admin section (super admin only)
  { href: '/admin/ai-providers', label: 'AI Providers', icon: Bot, requiresSuperAdmin: true, group: 'admin' },
  { href: '/admin/ai-providers/usage', label: 'AI Usage', icon: BarChart3, requiresSuperAdmin: true, group: 'admin' },
];

export function getNavItems(user: { name: string | null; email: string | null; isSuperAdmin?: boolean } | null): NavItem[] {
  return NAV_ITEMS.filter(item => {
    if (item.requiresAuth && !user) return false;
    if (item.requiresSuperAdmin && (!user || !user.isSuperAdmin)) return false;
    return true;
  });
}

