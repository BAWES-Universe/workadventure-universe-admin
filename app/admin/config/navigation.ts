import {
  Home,
  Orbit,
  Globe,
  Users,
  UserCircle,
  Mail,
  Compass,
  FolderOpen,
  Star,
  Bot,
  BarChart3,
  Database,
  Layers,
  Server,
  Building2,
  DoorOpen,
} from 'lucide-react';
import { LucideIcon } from 'lucide-react';

export type NavGroup = 'menu' | 'discover' | 'my' | 'admin';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  requiresAuth?: boolean;
  requiresSuperAdmin?: boolean;
  group?: NavGroup;
}

/**
 * The three places the bottom bar and the sidebar always show. Home is here and now, Space is everything you can
 * visit or manage, You is your visit card and account. Everything else lives one tap further, in the menu.
 */
export const DESTINATIONS: NavItem[] = [
  { href: '/admin', label: 'Home', icon: Home },
  { href: '/admin/space', label: 'Space', icon: Orbit },
  { href: '/admin/you', label: 'You', icon: UserCircle },
];

export const NAV_ITEMS: NavItem[] = [
  // Primary entry (no group, always at top)
  { href: '/admin', label: 'Home', icon: Home },

  // Room Templates - available to all users
  { href: '/admin/templates', label: 'Room Templates', icon: FolderOpen },

  // Personalize section
  { href: '/admin/universes', label: 'My Universes', icon: Globe, group: 'my' },
  { href: '/admin/stars', label: 'My Stars', icon: Star, group: 'my' },
  { href: '/admin/memberships', label: 'My Memberships', icon: Mail, requiresAuth: true, group: 'my' },
  { href: '/admin/profile', label: 'My Visit Card', icon: UserCircle, requiresAuth: true, group: 'my' },

  // Discover section
  { href: '/admin/discover/universes', label: 'Universes', icon: Compass, group: 'discover' },
  { href: '/admin/discover/worlds', label: 'Worlds', icon: Building2, group: 'discover' },
  { href: '/admin/discover/rooms', label: 'Rooms', icon: DoorOpen, group: 'discover' },
  { href: '/admin/users', label: 'Users', icon: Users, group: 'discover' },

  // Admin section (super admin only)
  { href: '/admin/avatars', label: 'Avatar Sets', icon: Layers, requiresSuperAdmin: true, group: 'admin' },
  { href: '/admin/bots', label: 'Bots', icon: Bot, requiresSuperAdmin: true, group: 'admin' },
  { href: '/admin/ai-providers', label: 'AI Providers', icon: Bot, requiresSuperAdmin: true, group: 'admin' },
  { href: '/admin/ai-providers/usage', label: 'AI Usage', icon: BarChart3, requiresSuperAdmin: true, group: 'admin' },
  { href: '/admin/bots/database', label: 'Bot Database', icon: Database, requiresSuperAdmin: true, group: 'admin' },
  { href: '/admin/bots/mcp-servers', label: 'MCP Servers', icon: Server, requiresSuperAdmin: true, group: 'admin' },
];

export const NAV_GROUP_LABELS: Record<NavGroup, string> = {
  menu: 'Tools',
  my: 'Personalize',
  discover: 'Discover',
  admin: 'Admin',
};

export interface NavUser {
  name: string | null;
  email: string | null;
  isSuperAdmin?: boolean;
}

export function getNavItems(user: NavUser | null): NavItem[] {
  return NAV_ITEMS.filter((item) => {
    if (item.requiresAuth && !user) return false;
    if (item.requiresSuperAdmin && (!user || !user.isSuperAdmin)) return false;
    return true;
  });
}

export interface NavSection {
  key: NavGroup;
  label: string;
  items: NavItem[];
}

/** The menu's sections in display order: Tools (Room Templates, first as before), Personalize, Discover, then Admin for super admins. Empty ones are left out. */
export function getNavSections(user: NavUser | null): NavSection[] {
  const items = getNavItems(user).filter((item) => item.href !== '/admin');
  const order: NavGroup[] = ['menu', 'my', 'discover', 'admin'];
  return order
    .map((key) => ({
      key,
      label: NAV_GROUP_LABELS[key],
      items: items.filter((item) => (item.group ?? 'menu') === key),
    }))
    .filter((section) => section.items.length > 0);
}

/** Whether `href` is the page shown, or one of its pages (the most specific entry wins). */
export function isNavItemActive(href: string, pathname: string, items: NavItem[] = NAV_ITEMS): boolean {
  if (href === '/admin') return pathname === '/admin';
  const moreSpecific = items.some(
    (item) => item.href !== href && item.href.startsWith(href + '/') && pathname.startsWith(item.href),
  );
  if (moreSpecific) return false;
  return pathname === href || pathname.startsWith(href + '/');
}
