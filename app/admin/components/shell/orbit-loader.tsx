import { OrbitMark } from './orbit-mark';
import { cn } from '@/lib/utils';

/**
 * The waiting moment, shown only when Orbit itself is starting (the first paint, and signing in). Pages never show
 * it: they keep the shell and put skeletons where their content goes.
 */
export function OrbitLoader({ label = 'Loading your orbit…', className }: { label?: string; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('flex min-h-[60dvh] flex-col items-center justify-center gap-4 text-center', className)}
    >
      <div className="relative">
        <div
          aria-hidden="true"
          className="absolute inset-0 rounded-full blur-2xl"
          style={{
            background: 'radial-gradient(closest-side, rgb(var(--brand-glow) / 0.35), transparent)',
            animation: 'orbit-breathe 2.4s ease-in-out infinite',
          }}
        />
        <OrbitMark animated className="relative h-14 w-14" />
      </div>
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
