import { cn } from '@/lib/utils';

/**
 * The waiting moment, shown only when Orbit itself is starting (the first paint, and signing in): the butterfly.
 * Pages never show it: they keep the shell and put skeletons where their content goes.
 */
export function OrbitLoader({ label = 'Loading your orbit…', className }: { label?: string; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('flex min-h-[60dvh] flex-col items-center justify-center gap-3 text-center', className)}
    >
      {/* 64px pixel art, drawn crisp at 2x; a static first frame under reduced motion is the browser's call. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/orbit-butterfly.webp" alt="" width={64} height={64} className="h-16 w-16 [image-rendering:pixelated]" />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
