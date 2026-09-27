'use client';

import { useSyncExternalStore } from 'react';

/**
 * The key for the Orbit Menu: ⌘K on a Mac, Ctrl K elsewhere. Shown only with a keyboard and a mouse (CSS), never on
 * a phone. The server renders Ctrl K; the browser corrects it for a Mac once hydrated.
 */
const noChange = () => () => undefined;
function onMac(): boolean {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad/i.test(platform);
}

export function ShortcutHint({ className }: { className?: string }) {
  const mac = useSyncExternalStore(noChange, onMac, () => false);
  return (
    <kbd className={['orbit-kbd', className].filter(Boolean).join(' ')} aria-hidden="true" data-testid="shortcut-hint">
      {mac ? '⌘K' : 'Ctrl K'}
    </kbd>
  );
}
