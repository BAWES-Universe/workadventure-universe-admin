'use client';

import Link from 'next/link';
import { ShieldCheck, UserRound } from 'lucide-react';
import { useAdminBootstrap } from '../admin-bootstrap-context';
import { ThemeChoice } from '../components/shell/theme-choice';
import Yours from '../components/yours';
import LogoutButton from '../logout-button';
import styles from './you.module.css';

/** You: who you are, what's yours (universes, worlds, stars), then how Orbit looks and signing out. */
export default function YouPage() {
  const { user } = useAdminBootstrap();
  const label = user.name || user.email || 'You';
  return (
    <div className={styles.page}>
      <header className={styles.person}>
        <div className={styles.personWords}>
          <h1 className="orbit-display">{label}</h1>
          <p>
            {user.name && user.email && <span className={styles.email}>{user.email}</span>}
            {user.isSuperAdmin && (
              <span className={styles.adminBadge}>
                <ShieldCheck size={13} aria-hidden="true" />
                Super admin
              </span>
            )}
          </p>
        </div>
        <Link href="/admin/profile" className={styles.visitCard}>
          <UserRound size={17} aria-hidden="true" />
          Visit card
        </Link>
      </header>
      <Yours />
      <footer className={styles.footer}>
        <section className={styles.appearance} aria-labelledby="appearance-heading">
          <h2 id="appearance-heading">Appearance</h2>
          <ThemeChoice className={styles.themeControl} />
        </section>
        <LogoutButton className="h-10 rounded-full" />
      </footer>
    </div>
  );
}
