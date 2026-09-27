'use client';

import { useSyncExternalStore } from 'react';

/**
 * The keys for the Orbit Menu, as keycaps: ⌘ K on a Mac, Ctrl K elsewhere. Shown only with a keyboard and a mouse,
 * while its control is hovered or keyboard-focused (CSS), never on a phone. `beside` floats it to the right of the control.
 * The server renders Ctrl; the browser corrects it for a Mac once hydrated.
 */
const noChange = () => () => undefined;
function onMac(): boolean {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad/i.test(platform);
}

export function ShortcutHint({ placement = 'inline', className }: { placement?: 'inline' | 'beside'; className?: string }) {
  const mac = useSyncExternalStore(noChange, onMac, () => false);
  return (
    <span
      className={['orbit-keys', className].filter(Boolean).join(' ')}
      data-placement={placement}
      aria-hidden="true"
      data-testid="shortcut-hint"
    >
      <kbd>{mac ? '⌘' : 'Ctrl'}</kbd>
      <kbd>K</kbd>
    </span>
  );
}
