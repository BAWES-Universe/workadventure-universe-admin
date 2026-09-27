'use client';

/**
 * Small pieces the bot tools share: a neutral filter row, a quiet status pill, a JSON disclosure and the pager.
 * Only the pages under /admin/bots use these.
 */

import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { Pager } from '../discover/discover-ui';

/** The filters over a list: one neutral card, labels above fields. */
export function FilterRow({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('grid gap-3 rounded-2xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4', className)}
    >
      {children}
    </div>
  );
}

export function FilterField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** A text filter applied with Enter or its search button (IDs are long; no request per keystroke). */
export function ApplyFilter({
  id,
  label,
  placeholder,
  value,
  onChange,
  onApply,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onApply: () => void;
}) {
  return (
    <FilterField id={id} label={label}>
      <div className="flex gap-2">
        <Input
          id={id}
          className="h-11 font-mono text-sm"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onApply();
          }}
        />
        <Button type="button" variant="outline" className="h-11 w-11 shrink-0 px-0" aria-label={`Filter by ${label.toLowerCase()}`} onClick={onApply}>
          <Search className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </FilterField>
  );
}

export function DateFilter({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return (
    <FilterField id={id} label={label}>
      <Input id={id} type="date" className="h-11" value={value} onChange={(e) => onChange(e.target.value)} />
    </FilterField>
  );
}

type Tone = 'ok' | 'waiting' | 'bad' | 'off';

const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  waiting: 'bg-amber-500',
  bad: 'bg-destructive',
  off: 'bg-muted-foreground/50',
};

/** A status word in a neutral outline with a small dot: never a colour block. */
export function Pill({ tone, children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium', className)}>
      {tone && <i className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[tone])} aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Raw JSON behind a disclosure. */
export function JsonDetails({ label, value, className }: { label: string; value: unknown; className?: string }) {
  return (
    <details className={cn('group', className)}>
      <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">{label}</summary>
      <pre className="mt-2 max-h-64 max-w-md overflow-auto rounded-lg bg-muted p-2 text-xs">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

/** A plain card holding a table or a panel of details. */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('min-w-0 overflow-hidden rounded-2xl border bg-card', className)}>{children}</div>;
}

/** A label and its value, stacked. */
export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export interface PageInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function ListPager({
  pagination,
  noun,
  loading,
  onChange,
}: {
  pagination: PageInfo | null;
  noun: [string, string];
  loading?: boolean;
  onChange: (page: number) => void;
}) {
  if (!pagination) return null;
  return (
    <Pager
      page={pagination.page}
      totalPages={pagination.totalPages}
      total={pagination.total}
      noun={noun}
      loading={loading}
      onChange={(next) => onChange(Math.max(1, Math.min(pagination.totalPages, next)))}
    />
  );
}
