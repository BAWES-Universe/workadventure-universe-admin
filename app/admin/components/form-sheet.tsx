'use client';

import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * A sheet that asks for something: it rises from the bottom on a phone and sits in the middle on a wide screen. It has
 * no close button: the way out is its own Cancel (Escape and a tap outside also close it).
 */
export function FormSheet({ open, onOpenChange, title, description, children, className }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Read out for screen readers; shown only when `showDescription`. */
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'top-auto bottom-0 left-0 max-h-[92dvh] w-full max-w-none translate-x-0 translate-y-0 gap-4 rounded-b-none rounded-t-[26px] border-x-0 border-b-0 p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]',
          'sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[560px] sm:max-w-[calc(100%-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[26px] sm:border sm:p-6',
          className,
        )}
      >
        <DialogTitle className="orbit-display text-2xl font-bold leading-tight">{title}</DialogTitle>
        <DialogDescription className={description ? undefined : 'sr-only'}>{description ?? 'Choose, then confirm or cancel.'}</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}
