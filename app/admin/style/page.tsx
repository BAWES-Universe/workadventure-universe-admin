'use client';

import { useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UNIVERSE_COLOURS } from '@/lib/universe-colour';
import {
  EmptyCard,
  EntityCard,
  EntityRow,
  Figure,
  Figures,
  InContext,
  KIND_LABEL,
  KindIcon,
  PageHeader,
  RolePills,
  SectionHeader,
  SettingSwitch,
  Settings,
  StatLine,
  StatusPill,
  VisitLine,
  count,
  type Kind,
} from '../components/ds';
import { QuestStamp } from '../components/quests/quest-stamp';
import { questCopy } from '@/lib/quests/copy';
import styles from './style.module.css';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const KINDS: Kind[] = ['universe', 'world', 'room', 'star', 'people'];

/** Orbit's building blocks and colour rules on one page, so every page can be checked against them. */
export default function StylePage() {
  return (
    <div className={styles.page}>
      <PageHeader title="Orbit style" context={<span className={styles.lede}>The colours, type and blocks every Orbit page is made of.</span>} />

      <section className={styles.section} aria-labelledby="colour">
        <SectionHeader id="colour" title="Colour rules" />
        <ul className={styles.rules}>
          <li>
            <span className={styles.swatch} style={{ background: 'hsl(var(--background))' }} />
            <span>
              <strong>Neutral base.</strong> Navy surfaces, white text. Links, tabs and pills are neutral.
            </span>
          </li>
          <li>
            <span className={styles.swatch} style={{ backgroundImage: 'var(--brand-gradient)' }} />
            <span>
              <strong>The gradient</strong> only for a page&apos;s one main action, the active destination and “you are here”.
            </span>
          </li>
          <li>
            <span className={styles.swatch} style={{ background: 'var(--status-live)' }} />
            <span>
              <strong>Status.</strong> Green live, amber waiting, red only for what can&apos;t be undone.
            </span>
          </li>
        </ul>
        <div className={styles.kinds}>
          {KINDS.map((kind) => (
            <span key={kind} className={styles.kind}>
              <KindIcon kind={kind} />
              {KIND_LABEL[kind]}
            </span>
          ))}
        </div>
        <p className={styles.note}>Each universe’s planet has its own shade, from its id:</p>
        <div className={styles.kinds}>
          {UNIVERSE_COLOURS.map((colour) => (
            <span key={colour} className={styles.dot} style={{ background: colour }} title={colour} />
          ))}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="buttons">
        <SectionHeader id="buttons" title="Buttons and pills" />
        <div className={styles.inline}>
          <Button className="h-11 gap-2 px-5">
            <Plus size={16} aria-hidden="true" />
            Main action
          </Button>
          <Button variant="outline" className="h-11 gap-2 px-5">
            <Pencil size={15} aria-hidden="true" />
            Secondary
          </Button>
          <Button variant="destructive" className="h-11 px-5">
            Delete
          </Button>
        </div>
        <div className={styles.inline}>
          <StatusPill status="public" />
          <StatusPill status="private" />
          <StatusPill status="featured" />
          <StatusPill status="live" />
          <StatusPill status="waiting" />
          <StatusPill status="published" />
          <StatusPill status="paused" />
          <RolePills roles={['member', 'owner', 'admin', 'editor']} />
        </div>
      </section>

      <section className={styles.section} aria-labelledby="stamps">
        <SectionHeader id="stamps" title="Quest stamps" />
        <p className={styles.note}>Lavender ring, gold glyph, tilted like an ink stamp; faded until earned. Always named beside it.</p>
        <div className={styles.kinds}>
          {(['meet', 'explore', 'build'] as const).map((path) => (
            <span key={path} className={styles.kind}>
              <QuestStamp path={path} />
              {questCopy(`stamps.${path}`)}
            </span>
          ))}
          <span className={styles.kind}>
            <QuestStamp path="explore" size="sm" muted />
            Not earned yet
          </span>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="header">
        <SectionHeader id="header" title="Page header" />
        <div className={styles.frame}>
          <PageHeader
            kind="world"
            title="Office"
            context={<InContext parts={[{ label: 'BAWES', href: '#' }]} />}
            status={<StatusPill status="public" />}
            stats={
              <Figures>
                <Figure value={1284} label="accesses" />
                <Figure value={3} label="rooms" />
                <Figure value={18} label="members" />
              </Figures>
            }
            actions={
              <>
                <Button className="h-10 gap-2 px-4">
                  <Plus size={15} aria-hidden="true" />
                  Create room
                </Button>
                <Button variant="outline" className="h-10 gap-2 px-4">
                  <Pencil size={14} aria-hidden="true" />
                  Edit
                </Button>
              </>
            }
          />
        </div>
      </section>

      <section className={styles.section} aria-labelledby="rows">
        <SectionHeader id="rows" title="Rows" count={3} action={{ href: '#', label: 'View all' }} />
        <EntityRow
          href="#"
          kind="universe"
          universeId="u-1"
          title="BAWES"
          context={<StatLine items={[count(2, 'world'), count(18, 'room')]} />}
          aside={<RolePills roles={['owner']} />}
        />
        <EntityRow
          href="#"
          kind="world"
          title="Office"
          context={<StatLine items={['BAWES', count(3, 'room'), count(18, 'member')]} />}
          aside={<RolePills roles={['admin']} />}
        />
        <EntityRow
          href="#"
          kind="room"
          title="Headquarters"
          context={<StatLine items={['BAWES › Office']} />}
          meta={<VisitLine you={minutesAgo(1440)} latest={minutesAgo(7)} />}
        />
      </section>

      <section className={styles.section} aria-labelledby="cards">
        <SectionHeader id="cards" title="Cards" action={{ href: '#', label: 'New universe', icon: Plus, primary: true }} />
        <div className={styles.grid}>
          <EntityCard
            href="#"
            kind="universe"
            universeId="u-2"
            title="Plugn"
            pills={<StatusPill status="private" />}
            description="A private universe for the Plugn product team."
            meta={<StatLine items={[count(1, 'world'), count(7, 'room'), count(1284, 'access', 'accesses')]} />}
          />
          <EntityCard
            href="#"
            kind="room"
            title="Creative Hub"
            context={<StatLine items={['BAWES › Campus East']} />}
            description="Whiteboards and quiet corners for design reviews."
            meta={
              <>
                <StatLine items={[count(1284, 'access', 'accesses'), 'Peak 4 PM']} />
                <VisitLine you={minutesAgo(40)} youWereLast />
              </>
            }
          />
        </div>
      </section>

      <section className={styles.section} aria-labelledby="empty">
        <SectionHeader id="empty" title="Empty states" />
        <div className={styles.stack}>
          <EmptyCard kind="universe" title="Every universe starts with an idea." text="Make yours, then add worlds and rooms." href="#" action="Create a universe" />
          <EmptyCard kind="star" title="Keep a way back to rooms you like." text="Star a room and it shows up here." href="#" action="Find rooms" />
        </div>
      </section>

      <section className={styles.section} aria-labelledby="settings">
        <SectionHeader id="settings" title="Settings" />
        <SettingsSample />
      </section>
    </div>
  );
}

/** An on/off setting says what on and off do; Featured shows only to super admins. */
function SettingsSample() {
  const [isPublic, setPublic] = useState(true);
  const [featured, setFeatured] = useState(false);
  return (
    <Settings label="Visibility">
      <SettingSwitch id="style-public" label="Public" hint="Shown in Space, and its public rooms are open to everyone. Off: members only." checked={isPublic} onChange={setPublic} />
      <SettingSwitch id="style-featured" label="Featured" hint="Pinned to the top of Space and Discover. Only super admins can change this." checked={featured} onChange={setFeatured} />
    </Settings>
  );
}
