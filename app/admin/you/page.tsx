'use client';

import { UserCircle, Mail, Star, ShieldCheck } from 'lucide-react';
import { useAdminBootstrap } from '../admin-bootstrap-context';
import { Avatar } from '../components/shell/account-panel';
import { ThemeChoice } from '../components/shell/theme-choice';
import { ListGroup, ListRow, SectionHeading } from '../components/shell/list-row';
import LogoutButton from '../logout-button';

/** You: your visit card, what you belong to, how Orbit looks, and the way out. */
export default function YouPage() {
  const { user, mine } = useAdminBootstrap();
  const label = user.name || user.email || 'You';

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-4">
        <Avatar user={user} className="h-16 w-16 text-xl" />
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{label}</h1>
          {user.email && user.name && <p className="truncate text-sm text-muted-foreground">{user.email}</p>}
          {user.isSuperAdmin && (
            <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-brand-gold/15 px-2 py-0.5 text-[11px] font-medium text-brand-gold">
              <ShieldCheck className="h-3 w-3" aria-hidden="true" />
              Super admin
            </span>
          )}
        </div>
      </header>

      <section>
        <SectionHeading title="Yours" />
        <ListGroup>
          <ListRow
            href="/admin/profile"
            icon={UserCircle}
            tone="brand"
            title="My Visit Card"
            subtitle="What people see when they tap you"
          />
          <ListRow
            href="/admin/memberships"
            icon={Mail}
            title="My Memberships"
            subtitle={
              mine
                ? `${mine.worlds} ${mine.worlds === 1 ? 'world' : 'worlds'}${mine.invitations ? ` · ${mine.invitations} waiting` : ''}`
                : 'Worlds you belong to'
            }
            trailing={
              mine?.invitations ? (
                <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground">
                  {mine.invitations}
                </span>
              ) : undefined
            }
          />
          <ListRow
            href="/admin/stars"
            icon={Star}
            title="My Stars"
            subtitle={mine ? `${mine.stars} ${mine.stars === 1 ? 'room' : 'rooms'}` : 'Rooms you starred'}
          />
        </ListGroup>
      </section>

      <section>
        <SectionHeading title="Appearance" />
        <ThemeChoice />
      </section>

      <section className="flex justify-end">
        <LogoutButton />
      </section>
    </div>
  );
}
