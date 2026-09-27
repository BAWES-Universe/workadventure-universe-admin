'use client';

/**
 * Orbit's building blocks. Every page is made of these, so a universe, a world, a room, a star or a person looks and
 * reads the same wherever it appears. The style page (/admin/style) shows each one.
 *
 * - KindIcon: the coloured chip that says what something is (a universe also in its own colour).
 * - EntityRow / EntityCard: one thing in a list, the whole row or card a single target.
 * - PageHeader: kind, name, where it is, one status and the page's actions. No breadcrumbs, no slugs.
 * - SectionHeader, EmptyCard, StatLine, VisitLine, RolePill, StatusPill.
 * - SettingSwitch: an on/off setting in a form, saying what on and off mean.
 */

import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { ArrowUpRight, Bot, Cpu, DoorOpen, Earth, Globe2, LayoutTemplate, Lock, Map as MapIcon, Shirt, Sparkles, Star, Tags, Users, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/time-ago';
import { universeColour } from '@/lib/universe-colour';
import { Switch } from '@/components/ui/switch';
import styles from './ds.module.css';

/** What players meet: each has its own colour. */
export type EntityKind = 'universe' | 'world' | 'room' | 'star' | 'people';
/** Super-admin tools: neutral chips, so they never read as a universe, world or room. */
export type ToolKind = 'template' | 'category' | 'map' | 'bot' | 'provider' | 'avatar';
export type Kind = EntityKind | ToolKind;

export const KIND_ICON: Record<Kind, LucideIcon> = {
  universe: Sparkles,
  world: Earth,
  room: DoorOpen,
  star: Star,
  people: Users,
  template: LayoutTemplate,
  category: Tags,
  map: MapIcon,
  bot: Bot,
  provider: Cpu,
  avatar: Shirt,
};

export const KIND_LABEL: Record<Kind, string> = {
  universe: 'Universe',
  world: 'World',
  room: 'Room',
  star: 'Star',
  people: 'People',
  template: 'Template',
  category: 'Category',
  map: 'Map',
  bot: 'Bot',
  provider: 'AI provider',
  avatar: 'Avatar set',
};

/** A universe's own colour as a style, for its chip, wash and planet. */
export function hueStyle(universeId?: string | null): CSSProperties | undefined {
  return universeId ? ({ '--hue': universeColour(universeId) } as CSSProperties) : undefined;
}

export function KindIcon({
  kind,
  size = 'md',
  universeId,
  className,
}: {
  kind: Kind;
  size?: 'sm' | 'md' | 'lg';
  /** Kept for callers; a chip is always its kind's colour (a universe's own colour is on its planet). */
  universeId?: string | null;
  className?: string;
}) {
  const Icon = KIND_ICON[kind];
  return (
    <span
      className={cn('orbit-kind', styles[`kind-${size}`], className)}
      data-kind={kind}
      aria-hidden="true"
    >
      <Icon size={size === 'sm' ? 14 : size === 'lg' ? 22 : 18} />
    </span>
  );
}

/** Where something is: "Universe › World", each part its own link when given one. */
export function Context({ parts }: { parts: { label: string; href?: string }[] }) {
  const shown = parts.filter((part) => part.label);
  if (shown.length === 0) return null;
  return (
    <span className={styles.context}>
      {shown.map((part, index) => (
        <span key={`${part.label}-${index}`}>
          {index > 0 && <span aria-hidden="true"> › </span>}
          {part.label}
        </span>
      ))}
    </span>
  );
}

/** Numbers about something, in one format everywhere: "1,284 accesses · 3 rooms · 18 members". */
export function StatLine({ items }: { items: (string | false | null | undefined)[] }) {
  const shown = items.filter(Boolean) as string[];
  if (shown.length === 0) return null;
  return <span className={styles.stats}>{shown.join(' · ')}</span>;
}

export function count(value: number | null | undefined, one: string, many = `${one}s`): string | null {
  if (typeof value !== 'number') return null;
  return `${value.toLocaleString()} ${value === 1 ? one : many}`;
}

/** When you were last there, and when anyone was: the same words on every card. */
export function VisitLine({ you, latest, youWereLast }: { you?: string | null; latest?: string | null; youWereLast?: boolean }) {
  if (!you && !latest) return null;
  return (
    <span className={styles.visits}>
      {you ? (
        <span>
          Last visited by you <strong>{timeAgo(new Date(you))}</strong>
        </span>
      ) : (
        <span>You haven’t visited yet</span>
      )}
      {youWereLast ? (
        <span>You were the last visitor</span>
      ) : (
        latest && (
          <span>
            Most recent visitor <strong>{timeAgo(new Date(latest))}</strong>
          </span>
        )
      )}
    </span>
  );
}

const ROLE_ORDER = ['owner', 'admin', 'editor', 'member'];

/** Someone's role in a world or universe: one neutral style; owner carries the gold dot. */
export function RolePill({ role }: { role: string }) {
  const name = role.toLowerCase();
  return (
    <span className={styles.pill} data-role={name}>
      {name === 'owner' && <i className={styles.ownerDot} aria-hidden="true" />}
      {name.charAt(0).toUpperCase() + name.slice(1)}
    </span>
  );
}

export function RolePills({ roles }: { roles: string[] }) {
  const sorted = [...new Set(roles.map((role) => role.toLowerCase()))].sort(
    (a, b) => (ROLE_ORDER.indexOf(a) + 1 || 99) - (ROLE_ORDER.indexOf(b) + 1 || 99),
  );
  return (
    <span className={styles.pills}>
      {sorted.map((role) => (
        <RolePill key={role} role={role} />
      ))}
    </span>
  );
}

/** Public, Private, Featured, Live: neutral outline with an icon, never a colour block. */
export function StatusPill({ status }: { status: 'public' | 'private' | 'featured' | 'live' | 'waiting' }) {
  const label = { public: 'Public', private: 'Private', featured: 'Featured', live: 'You’re here', waiting: 'Waiting' }[status];
  const Icon = status === 'public' ? Globe2 : status === 'private' ? Lock : status === 'featured' ? Star : null;
  return (
    <span className={styles.pill} data-status={status}>
      {Icon ? <Icon size={11} aria-hidden="true" /> : <i className={styles.statusDot} aria-hidden="true" />}
      {label}
    </span>
  );
}

/**
 * One thing in a list. The whole row is the link; nothing else in it is a separate target except `trailing`, which
 * sits above the link (for Accept / Decline and the like).
 */
export function EntityRow({
  href,
  kind,
  universeId,
  title,
  context,
  meta,
  aside,
  trailing,
  leading,
  tone,
  testId,
}: {
  href: string;
  kind: Kind;
  /** An item waiting for you (an invitation): an amber card. */
  tone?: 'waiting';
  universeId?: string | null;
  title: string;
  context?: ReactNode;
  meta?: ReactNode;
  /** In place of the kind's chip (a person's Woka, say). */
  leading?: ReactNode;
  /** Quiet information at the end (a star count, a role). */
  aside?: ReactNode;
  /** Controls of their own, kept out of the row's link. */
  trailing?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className={cn(styles.row, 'orbit-kind-wash')}
      data-kind={kind}
      data-tone={tone}
      style={kind === 'universe' ? hueStyle(universeId) : undefined}
      data-testid={testId}
    >
      {leading ?? <KindIcon kind={kind} universeId={universeId} />}
      <div className={styles.rowText}>
        <Link href={href} className={styles.stretched}>
          <strong>{title}</strong>
        </Link>
        {context}
        {meta}
      </div>
      {aside && <div className={styles.aside}>{aside}</div>}
      {trailing ? <div className={styles.trailing}>{trailing}</div> : <ArrowUpRight className={styles.arrow} size={16} aria-hidden="true" />}
    </div>
  );
}

/** One thing as a card, with room for a description. The whole card is the link. */
export function EntityCard({
  href,
  kind,
  universeId,
  title,
  context,
  description,
  pills,
  meta,
  aside,
  testId,
}: {
  href: string;
  kind: Kind;
  universeId?: string | null;
  title: string;
  context?: ReactNode;
  description?: string | null;
  pills?: ReactNode;
  meta?: ReactNode;
  aside?: ReactNode;
  testId?: string;
}) {
  return (
    <article
      className={cn(styles.card, 'orbit-kind-wash')}
      data-kind={kind}
      style={kind === 'universe' ? hueStyle(universeId) : undefined}
      data-testid={testId}
    >
      <div className={styles.cardTop}>
        <KindIcon kind={kind} universeId={universeId} />
        <div className={styles.rowText}>
          <h3>
            <Link href={href} className={styles.stretched}>
              {title}
            </Link>
          </h3>
          {context}
        </div>
        {aside && <div className={styles.aside}>{aside}</div>}
      </div>
      {pills && <div className={styles.cardPills}>{pills}</div>}
      {description && <p className={styles.description}>{description}</p>}
      {meta && <div className={styles.cardMeta}>{meta}</div>}
    </article>
  );
}

/** A page's top: what it is, where it is, one status, and the page's actions. */
export function PageHeader({
  kind,
  universeId,
  title,
  context,
  status,
  stats,
  actions,
  children,
}: {
  kind?: Kind;
  universeId?: string | null;
  title: string;
  /** Where it is, e.g. "In BAWES › Office", with links. */
  context?: ReactNode;
  status?: ReactNode;
  stats?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className={styles.pageHeader} data-testid="page-header">
      <div className={styles.pageTitleRow}>
        {kind && <KindIcon kind={kind} universeId={universeId} size="lg" />}
        <div className={styles.pageTitle}>
          <h1 className="orbit-display">{title}</h1>
          {(context || status) && (
            <div className={styles.pageContext}>
              {context}
              {status}
            </div>
          )}
        </div>
      </div>
      {stats && <div className={styles.pageStats}>{stats}</div>}
      {children}
      {actions && <div className={styles.pageActions}>{actions}</div>}
    </header>
  );
}

/** "In BAWES › Office": where a page's thing lives, each part a link. */
export function InContext({ parts }: { parts: { label: string; href: string }[] }) {
  return (
    <span className={styles.inContext}>
      In{' '}
      {parts.map((part, index) => (
        <span key={part.href}>
          {index > 0 && <span aria-hidden="true"> › </span>}
          <Link href={part.href}>{part.label}</Link>
        </span>
      ))}
    </span>
  );
}

/** A section's title with an optional count and one action (hidden when there is nothing to see). */
export function SectionHeader({
  id,
  title,
  count: total,
  action,
}: {
  id?: string;
  title: string;
  count?: number;
  action?: { href: string; label: string; icon?: LucideIcon; primary?: boolean } | null;
}) {
  const Icon = action?.icon;
  return (
    <div className={styles.sectionHeader}>
      <h2 id={id} className="orbit-display">
        {title}
        {typeof total === 'number' && total > 0 && <span className={styles.sectionCount}>{total.toLocaleString()}</span>}
      </h2>
      {action && (
        <Link href={action.href} className={cn(styles.sectionAction, action.primary && styles.sectionActionPrimary)}>
          {Icon && <Icon size={15} aria-hidden="true" />}
          {action.label}
        </Link>
      )}
    </div>
  );
}

/** Nothing here yet: says what would be here, and one tap leads to making or finding it. */
export function EmptyCard({
  kind,
  title,
  text,
  href,
  action,
  testId,
}: {
  kind: Kind;
  title: string;
  text: string;
  href?: string;
  action?: string;
  testId?: string;
}) {
  const body = (
    <>
      <KindIcon kind={kind} />
      <span className={styles.emptyText}>
        <strong>{title}</strong>
        <span>{text}</span>
        {href && action && <span className={styles.emptyAction}>{action}</span>}
      </span>
      {href && <ArrowUpRight className={styles.arrow} size={18} aria-hidden="true" />}
    </>
  );
  return href ? (
    <Link href={href} className={cn(styles.empty, 'orbit-kind-wash')} data-kind={kind} data-testid={testId}>
      {body}
    </Link>
  ) : (
    <div className={cn(styles.empty, 'orbit-kind-wash')} data-kind={kind} data-testid={testId}>
      {body}
    </div>
  );
}

/** A number with its label, for a page's headline figures. */
export function Figure({ value, label }: { value: string | number; label: string }) {
  return (
    <span className={styles.figure}>
      <strong>{typeof value === 'number' ? value.toLocaleString() : value}</strong>
      <span>{label}</span>
    </span>
  );
}

export function Figures({ children }: { children: ReactNode }) {
  return <div className={styles.figures}>{children}</div>;
}

/** A list still on its way: quiet placeholder rows, not a spinner. */
export function LoadingRows({ label, rows = 2 }: { label: string; rows?: number }) {
  return (
    <div className={styles.loadingRows} role="status" aria-label={`Loading ${label}`}>
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="orbit-skeleton" />
      ))}
    </div>
  );
}

/** A list that couldn't load says so, with one way to try again. */
export function LoadError({ label, retry }: { label: string; retry: () => void }) {
  return (
    <div className={styles.loadError} role="alert">
      <span>We couldn’t load {label}.</span>
      <button type="button" onClick={retry}>
        Try again
      </button>
    </div>
  );
}

/**
 * One on/off setting in a form. The label says what it is; the hint says what on and off do, so nobody has to guess.
 * The whole row toggles it.
 */
export function SettingSwitch({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label htmlFor={id} className={styles.setting} data-disabled={disabled || undefined}>
      <span className={styles.settingText}>
        <strong id={`${id}-label`}>{label}</strong>
        <span id={`${id}-hint`}>{hint}</span>
      </span>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
        className="orbit-touch-exempt"
      />
    </label>
  );
}

/** A group of SettingSwitch rows. */
export function Settings({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <fieldset className={styles.settings}>
      {label && <legend className="sr-only">{label}</legend>}
      {children}
    </fieldset>
  );
}
