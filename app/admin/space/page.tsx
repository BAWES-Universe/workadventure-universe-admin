'use client';

import Link from 'next/link';
import { ArrowUpRight, DoorOpen, Earth, Plus, Sparkles, Users, type LucideIcon } from 'lucide-react';
import { useAdminBootstrap } from '../admin-bootstrap-context';
import styles from './space.module.css';

/** Space: everything out there to explore. What's yours is on You. */
export default function SpacePage() {
  return (
    <div className={styles.page}>
      <h1 className="sr-only">Space</h1>
      <Explore />
    </div>
  );
}

function Explore() {
  const { stats } = useAdminBootstrap();
  return (
    <div className={styles.explore} data-testid="space-explore">
      <section className={styles.discovery} aria-labelledby="discovery-heading">
        <div className={styles.discoveryIntro}>
          <span className={styles.eyebrow}>Beyond your orbit</span>
          <h2 id="discovery-heading" className="orbit-display">
            Across the Universe
          </h2>
          <p>Public universes, worlds and rooms anyone can visit, and the people in them.</p>
          <div className={styles.discoveryOrbit} aria-hidden="true">
            <i />
            <i />
            <i />
            <span />
          </div>
        </div>
        <div className={styles.discoveryLinks}>
          <ExploreLink href="/admin/discover/universes" icon={Sparkles} kind="universe" title="Universes" count={stats.universes} description="Public universes you can explore" />
          <ExploreLink href="/admin/discover/worlds" icon={Earth} kind="world" title="Worlds" count={stats.worlds} description="Worlds across universes" />
          <ExploreLink href="/admin/discover/rooms" icon={DoorOpen} kind="room" title="Rooms" count={stats.rooms} description="Individual spaces & maps" />
          <ExploreLink href="/admin/users" icon={Users} kind="star" title="Users" count={stats.users} description="People exploring the Universe" />
        </div>
      </section>
      <section className={styles.build} aria-labelledby="build-heading">
        <div>
          <p className={styles.eyebrow}>Leave your mark</p>
          <h2 id="build-heading" className="orbit-display">
            Build something of your own
          </h2>
          <p>A universe holds your worlds and rooms. It takes a minute, and you can shape it later.</p>
        </div>
        <div className={styles.buildActions}>
          <Link className={styles.create} href="/admin/universes/new">
            <Plus size={17} aria-hidden="true" />
            Create a universe
          </Link>
          <Link className={styles.textAction} href="/admin/templates">
            Browse room templates
            <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </section>
    </div>
  );
}

function ExploreLink({ href, icon: Icon, kind, title, count, description }: { href: string; icon: LucideIcon; kind: 'universe' | 'world' | 'room' | 'star'; title: string; count: number; description: string }) {
  return (
    <Link className={`${styles.exploreLink} orbit-kind-wash`} data-kind={kind === 'star' ? 'universe' : kind} href={href}>
      <span className="orbit-kind" data-kind={kind} aria-hidden="true">
        <Icon size={18} />
      </span>
      <span>
        <strong>
          {title} <span className={styles.count}>{count.toLocaleString()}</span>
        </strong>
        <span>{description}</span>
      </span>
      <ArrowUpRight size={20} aria-hidden="true" />
    </Link>
  );
}
