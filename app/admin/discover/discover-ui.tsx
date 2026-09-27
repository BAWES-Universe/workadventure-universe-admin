'use client';

import type { FormEvent } from 'react';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** One rounded search field, as on Space: Enter searches, the × clears. */
export function SearchBox({
  value,
  onChange,
  onSubmit,
  onClear,
  placeholder,
  label,
  showClear,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  placeholder: string;
  label: string;
  /** Show the × even when the field is empty (a search is still applied). */
  showClear?: boolean;
  testId?: string;
}) {
  return (
    <form
      role="search"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label className="flex min-h-[52px] min-w-0 items-center gap-2.5 rounded-full border border-border bg-card pl-4 pr-2 text-muted-foreground shadow-[0_12px_30px_-24px_rgb(0_0_0/0.8)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
        <Search size={18} aria-hidden="true" className="shrink-0" />
        <span className="sr-only">{label}</span>
        <input
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          data-testid={testId}
          className="h-[50px] min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {(value || showClear) && (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear the search"
            className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </label>
    </form>
  );
}

/** Previous / Next under a long list, with where you are. */
export function Pager({
  page,
  totalPages,
  total,
  noun,
  loading,
  onChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  noun: [string, string];
  loading?: boolean;
  onChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
      <span className="text-xs text-muted-foreground">
        Page {page} of {totalPages} · {total.toLocaleString()} {total === 1 ? noun[0] : noun[1]}
      </span>
      <div className="flex gap-2">
        <Button variant="outline" className="h-9 px-4" onClick={() => onChange(page - 1)} disabled={page <= 1 || loading}>
          Previous
        </Button>
        <Button variant="outline" className="h-9 px-4" onClick={() => onChange(page + 1)} disabled={page >= totalPages || loading}>
          Next
        </Button>
      </div>
    </div>
  );
}
