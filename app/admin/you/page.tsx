'use client';

import Link from 'next/link';
import { ArrowUpRight, Mail, ShieldCheck, Star, UserRound } from 'lucide-react';
import { useAdminBootstrap } from '../admin-bootstrap-context';
import { initialsOf } from '../components/shell/account-panel';
import { ThemeChoice } from '../components/shell/theme-choice';
import LogoutButton from '../logout-button';
import styles from './you.module.css';

/** You: who you're signed in as, what's yours, how Orbit looks, and signing out. */
export default function YouPage() {
  const { user, mine } = useAdminBootstrap();
  const label = user.name || user.email || 'You';
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className="orbit-eyebrow">Your account</p>
        <h1>
          You<span>.</span>
        </h1>
      </header>
      <section className={styles.identity} aria-labelledby="identity-heading">
        <div className={styles.identityArt} aria-hidden="true">
          <div className={styles.identityRing} />
          <div className={styles.identityRingInner} />
          <span className={styles.initials}>{initialsOf(user)}</span>
          <span className={styles.satellite} />
        </div>
        <div className={styles.identityContent}>
          <h2 id="identity-heading">{label}</h2>
          {user.name && user.email && <p className={styles.email}>{user.email}</p>}
          {user.isSuperAdmin && (
            <span className={styles.adminBadge}>
              <ShieldCheck size={13} aria-hidden="true" />
              Super admin
            </span>
          )}
        </div>
      </section>
      <div className={styles.details}>
        <section className={styles.connections} aria-labelledby="connections-heading">
          <h2 id="connections-heading" className={styles.sectionTitle}>
            Yours
          </h2>
          <Link className={styles.connection} href="/admin/profile">
            <UserRound size={20} aria-hidden="true" />
            <span>
              <strong>My Visit Card</strong>
              <span>What people see when they click on you</span>
            </span>
            <ArrowUpRight size={17} aria-hidden="true" />
          </Link>
          <Link className={styles.connection} href="/admin/memberships">
            <Mail size={20} aria-hidden="true" />
            <span>
              <strong>My Memberships</strong>
              <span>{mine ? `${mine.worlds} ${mine.worlds === 1 ? 'world' : 'worlds'}` : 'Worlds you belong to'}</span>
            </span>
            {Boolean(mine?.invitations) && <span className={styles.invitation}>{mine!.invitations} waiting</span>}
            <ArrowUpRight size={17} aria-hidden="true" />
          </Link>
          <Link className={styles.connection} href="/admin/stars">
            <Star size={20} aria-hidden="true" />
            <span>
              <strong>My Stars</strong>
              <span>{mine ? `${mine.stars} ${mine.stars === 1 ? 'room' : 'rooms'}` : 'Rooms you starred'}</span>
            </span>
            <ArrowUpRight size={17} aria-hidden="true" />
          </Link>
        </section>
        <section className={styles.appearance} aria-labelledby="appearance-heading">
          <h2 id="appearance-heading" className={styles.sectionTitle}>
            Appearance
          </h2>
          <ThemeChoice className={styles.themeControl} />
        </section>
      </div>
      <footer className={styles.footer}>
        <p>Signed in as {user.email ?? label}</p>
        <LogoutButton className="h-10 rounded-full" />
      </footer>
    </div>
  );
}
