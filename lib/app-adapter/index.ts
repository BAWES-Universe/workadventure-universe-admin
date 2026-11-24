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
 * The adapter, or null when it is off. It is ON as soon as COMPOSIO_API_KEY is set in
 * Orbit's environment (0.5.0 sets it); without the key nothing of it is reachable or shown anywhere, and the routes answer 404.
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
