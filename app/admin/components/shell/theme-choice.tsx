'use client';

import { useRef, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Moon, Sun, MonitorSmartphone } from 'lucide-react';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';

const CHOICES = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'Auto', icon: MonitorSmartphone },
] as const;

const subscribeToHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/** Light, dark or the device's choice, as a keyboard-operable radio group. */
export function ThemeChoice({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribeToHydration, clientSnapshot, serverSnapshot);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const current = mounted ? (theme ?? 'dark') : 'dark';

  function chooseWithKeyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % CHOICES.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + CHOICES.length - 1) % CHOICES.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = CHOICES.length - 1;
    else return;
    event.preventDefault();
    setTheme(CHOICES[next].value);
    buttons.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className={cn('grid grid-cols-3 gap-1 rounded-xl bg-muted p-1', className)}
    >
      {CHOICES.map((choice, index) => {
        const Icon = choice.icon;
        const active = current === choice.value;
        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            ref={(element) => { buttons.current[index] = element; }}
            onKeyDown={(event) => chooseWithKeyboard(event, index)}
            onClick={() => setTheme(choice.value)}
            className={cn(
              'orbit-press flex min-h-11 items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition-colors',
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
