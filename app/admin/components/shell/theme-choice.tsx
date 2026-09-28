'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun, MonitorSmartphone } from 'lucide-react';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';

const CHOICES = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'Auto', icon: MonitorSmartphone },
] as const;

/** Light, dark or the device's choice, as a segmented control. */
export function ThemeChoice({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current = mounted ? (theme ?? 'dark') : 'dark';

  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className={cn('grid grid-cols-3 gap-1 rounded-xl bg-muted p-1', className)}
    >
      {CHOICES.map((choice) => {
        const Icon = choice.icon;
        const active = current === choice.value;
        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(choice.value)}
            className={cn(
              'orbit-press flex h-9 items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition-colors',
              active ? 'bg-elevated text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {choice.label}
          </button>
        );
      })}
    </div>
  );
}
