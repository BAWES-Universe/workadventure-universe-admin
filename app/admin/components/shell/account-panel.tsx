'use client';

import { ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ThemeChoice } from './theme-choice';
import LogoutButton from '../../logout-button';

export interface AccountPanelUser {
  name: string | null;
  email: string | null;
  isSuperAdmin?: boolean;
}

export function initialsOf(user: AccountPanelUser): string {
  const source = (user.name || user.email || '?').trim();
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const initials = parts.length >= 2 ? parts[0][0] + parts[1][0] : source.slice(0, 2);
  return initials.toUpperCase();
}

/** A person's initials in a brand circle. */
export function Avatar({ user, className }: { user: AccountPanelUser; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'orbit-brand-fill inline-flex shrink-0 items-center justify-center rounded-full text-sm font-semibold tracking-wide',
        className,
      )}
    >
      {initialsOf(user)}
    </span>
  );
}

/**
 * Who is signed in, the appearance choice and Sign out. The sidebar's foot, the menu's foot and the You page share
 * it; `compact` is the sidebar's single-row version.
 */
export function AccountPanel({ user, compact = false }: { user: AccountPanelUser; compact?: boolean }) {
  const label = user.name || user.email || 'Signed in';
  return (
    <div className={cn('space-y-3', compact && 'space-y-2')}>
      <div className="flex items-center gap-3">
        <Avatar user={user} className={compact ? 'h-9 w-9 text-xs' : 'h-12 w-12'} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{label}</p>
          {user.email && user.name && <p className="truncate text-xs text-muted-foreground">{user.email}</p>}
          {user.isSuperAdmin && (
            <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-brand-gold">
              <ShieldCheck className="h-3 w-3" aria-hidden="true" />
              Super admin
            </span>
          )}
        </div>
      </div>
      {!compact && <ThemeChoice />}
      <div className={cn('flex items-center', compact ? 'justify-between' : 'justify-end')}>
        {compact && <ThemeChoice className="w-full" />}
        {!compact && <LogoutButton />}
      </div>
      {compact && <LogoutButton className="w-full justify-center" />}
    </div>
  );
}
