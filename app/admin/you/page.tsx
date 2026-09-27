'use client';

import Link from 'next/link';
import { ArrowUpRight, Fingerprint, Mail, ShieldCheck, Sparkles, Star, UserRound } from 'lucide-react';
import { useAdminBootstrap } from '../admin-bootstrap-context';
import { initialsOf } from '../components/shell/account-panel';
import { ThemeChoice } from '../components/shell/theme-choice';
import LogoutButton from '../logout-button';
import styles from './you.module.css';

/** A traveller's identity, belongings and preferences, backed by the signed-in account. */
export default function YouPage() {
  const { user, mine } = useAdminBootstrap();
  const label = user.name || user.email || 'You';
  return (
    <div className={styles.page}>
      <header className={styles.header}><p className={styles.eyebrow}><Fingerprint size={13} aria-hidden="true" /> Your presence</p><h1>You, in every world<span>.</span></h1><p>One identity. Everywhere you belong.</p></header>
      <section className={styles.identity} aria-labelledby="identity-heading">
        <div className={styles.identityArt} aria-hidden="true"><div className={styles.identityRing} /><div className={styles.identityRingInner} /><span className={styles.initials}>{initialsOf(user)}</span><span className={styles.satellite} /><span className={styles.coordinates}>UNIVERSE / ORBIT</span></div>
        <div className={styles.identityContent}>
          <div className={styles.cardTop}><span>Traveller identity</span><Sparkles size={16} aria-hidden="true" /></div>
          <h2 id="identity-heading">{label}</h2>
          {user.name && user.email && <p className={styles.email}>{user.email}</p>}
          {user.isSuperAdmin && <span className={styles.adminBadge}><ShieldCheck size={13} aria-hidden="true" />Super admin</span>}
          <div className={styles.cardBottom}><span>The person behind the avatar.</span><Link href="/admin/profile">My Visit Card<ArrowUpRight size={17} aria-hidden="true" /></Link></div>
        </div>
      </section>
      <div className={styles.details}>
        <section className={styles.connections} aria-labelledby="connections-heading">
          <h2 id="connections-heading" className={styles.sectionTitle}><span>01</span>Your connections</h2>
          <Link className={styles.connection} href="/admin/memberships"><Mail size={20} aria-hidden="true" /><span><strong>My Memberships</strong><span>{mine ? `${mine.worlds} ${mine.worlds === 1 ? 'world' : 'worlds'} you belong to` : 'Worlds you belong to'}</span></span>{Boolean(mine?.invitations) && <span className={styles.invitation}>{mine!.invitations} waiting</span>}<ArrowUpRight size={17} aria-hidden="true" /></Link>
          <Link className={styles.connection} href="/admin/stars"><Star size={20} aria-hidden="true" /><span><strong>My Stars</strong><span>{mine ? `${mine.stars} ${mine.stars === 1 ? 'room' : 'rooms'} worth coming back to` : 'Rooms worth coming back to'}</span></span><ArrowUpRight size={17} aria-hidden="true" /></Link>
          <Link className={styles.connection} href="/admin/profile"><UserRound size={20} aria-hidden="true" /><span><strong>Edit my profile</strong><span>Your bio, links and what you share.</span></span><ArrowUpRight size={17} aria-hidden="true" /></Link>
        </section>
        <section className={styles.appearance} aria-labelledby="appearance-heading"><h2 id="appearance-heading" className={styles.sectionTitle}><span>02</span>Your atmosphere</h2><div className={styles.appearanceScene} aria-hidden="true"><span className={styles.sun} /><span className={styles.horizon} /></div><h3>Set the mood.</h3><p>Light, dark, or in rhythm with your device.</p><ThemeChoice className={styles.themeControl} /></section>
      </div>
      <footer className={styles.footer}><p>Signed in to Orbit</p><LogoutButton className="h-11" /></footer>
    </div>
  );
}
