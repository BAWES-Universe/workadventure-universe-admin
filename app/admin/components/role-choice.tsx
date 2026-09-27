'use client';

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export const ROLE_OPTIONS: { value: string; label: string; description: string }[] = [
  { value: 'admin', label: 'Admin', description: 'Manages members, rooms and settings' },
  { value: 'editor', label: 'Editor', description: 'Edits the world and its rooms' },
  { value: 'member', label: 'Member', description: 'Belongs to the world and its private rooms' },
];

/**
 * A role, chosen from a full-width list: every option and what it means is visible at once, on a phone as on a
 * desk, with nothing to drop down.
 */
export function RoleChoice({
  value,
  onChange,
  options = ROLE_OPTIONS,
  name = 'role',
  labelledBy,
}: {
  value: string;
  onChange: (value: string) => void;
  options?: typeof ROLE_OPTIONS;
  name?: string;
  /** The id of the visible label naming this choice. */
  labelledBy?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : 'Role'}
      className="overflow-hidden rounded-xl border border-border/70">
      {options.map((option, index) => {
        const checked = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            name={name}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors',
              index > 0 && 'border-t border-border/60',
              checked ? 'bg-accent/60' : 'hover:bg-muted/50',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors',
                checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
              )}
            >
              {checked && <Check className="h-3 w-3" strokeWidth={3} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="block text-xs text-muted-foreground">{option.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
