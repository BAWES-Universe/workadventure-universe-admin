'use client';

import { History } from 'lucide-react';

/** Shown when a form came back with what was typed earlier, so nothing is replaced without saying so. */
export function DraftNotice({ onDiscard }: { onDiscard: () => void }) {
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
      data-testid="draft-notice"
    >
      <span className="flex items-center gap-2">
        <History className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        Restored what you typed earlier.
      </span>
      <button type="button" onClick={onDiscard} className="shrink-0 font-medium text-primary hover:underline">
        Discard draft
      </button>
    </div>
  );
}
