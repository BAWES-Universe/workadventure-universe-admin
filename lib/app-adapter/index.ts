import { createComposioAdapter } from '@/lib/app-adapter/composio';
import { authConfigFor } from '@/lib/app-adapter/settings';
import { AdapterError, type ReadyMadeAdapter } from '@/lib/app-adapter/types';

export * from '@/lib/app-adapter/types';

let override: ReadyMadeAdapter | null | undefined;

/** For tests: a fake in place of the real adapter (null for off). Call with undefined to go back to the environment. */
export function setAdapterForTests(adapter: ReadyMadeAdapter | null | undefined): void {
  override = adapter;
}

/**
 * The adapter, or null when it is off. Off is the only state until Khalid says otherwise: it means no COMPOSIO_API_KEY in
 * Orbit's environment, and then nothing of it is reachable or shown anywhere.
 */
export function getAdapter(): ReadyMadeAdapter | null {
  if (override !== undefined) return override;
  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) return null;
  return createComposioAdapter({ apiKey, authConfigFor });
}

export const adapterIsOn = (): boolean => getAdapter() !== null;

export function requireAdapter(): ReadyMadeAdapter {
  const adapter = getAdapter();
  if (!adapter) throw new AdapterError('off', 'The ready-made apps adapter is off');
  return adapter;
}
