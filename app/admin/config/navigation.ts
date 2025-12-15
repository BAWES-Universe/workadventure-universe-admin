import { LayoutDashboard, Globe, Users, UserCircle, Mail } from 'lucide-react';
import { LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  requiresAuth?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/universes', label: 'Universes', icon: Globe },
  { href: '/admin/users', label: 'Users', icon: Users },
  { href: '/admin/memberships', label: 'My Memberships', icon: Mail, requiresAuth: true },
  { href: '/admin/profile', label: 'Visit Card', icon: UserCircle, requiresAuth: true },
];

export function getNavItems(user: { name: string | null; email: string | null } | null): NavItem[] {
  return NAV_ITEMS.filter(item => !item.requiresAuth || user !== null);
}

