import Link from 'next/link';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ListRowProps {
  href?: string;
  onClick?: () => void;
  icon?: LucideIcon;
  /** A small picture instead of an icon. */
  leading?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** What sits at the end: a count, a badge, a button. A chevron when nothing is given and the row goes somewhere. */
  trailing?: React.ReactNode;
  className?: string;
  tone?: 'default' | 'brand';
}

/**
 * One line of a list: an icon or picture, a title, a quiet subtitle, something at the end. Rows sit inside
 * `ListGroup`, which draws the card and the hairlines between them.
 */
export function ListRow({ href, onClick, icon: Icon, leading, title, subtitle, trailing, className, tone = 'default' }: ListRowProps) {
  const interactive = Boolean(href || onClick);
  const body = (
    <>
      {leading ??
        (Icon && (
          <span
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
              tone === 'brand' ? 'orbit-brand-fill' : 'bg-muted text-muted-foreground',
            )}
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
        ))}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium leading-tight">{title}</span>
        {subtitle && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{subtitle}</span>}
      </span>
      {trailing ?? (interactive && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden="true" />)}
    </>
  );
  const classes = cn(
    'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors',
    interactive && 'active:bg-muted/70 hover:bg-muted/40',
    className,
  );
  if (href) {
    return (
      <Link href={href} className={classes}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={classes}>
        {body}
      </button>
    );
  }
  return <div className={classes}>{body}</div>;
}

/** A card of rows with hairlines between them. */
export function ListGroup({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('orbit-card divide-y divide-border/60 overflow-hidden', className)}>{children}</div>
  );
}

/** A section's title line, with an optional action on the right ("See all"). */
export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="shrink-0 text-sm">{action}</div>}
    </div>
  );
}

/** A number and what it counts, tappable when it leads somewhere. */
export function StatTile({
  href,
  icon: Icon,
  value,
  label,
  accent = 'brand',
}: {
  href: string;
  icon: LucideIcon;
  value: number | string;
  label: string;
  accent?: 'brand' | 'gold' | 'muted';
}) {
  return (
    <Link
      href={href}
      className="orbit-card orbit-card-interactive block p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        className={cn(
          'mb-3 flex h-9 w-9 items-center justify-center rounded-xl',
          accent === 'brand' && 'orbit-brand-fill',
          accent === 'gold' && 'bg-brand-gold/20 text-brand-gold',
          accent === 'muted' && 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
      </span>
      <span className="block text-2xl font-semibold tabular-nums tracking-tight">{typeof value === 'number' ? value.toLocaleString() : value}</span>
      <span className="block text-xs text-muted-foreground">{label}</span>
    </Link>
  );
}
