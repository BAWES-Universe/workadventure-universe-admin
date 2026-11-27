/**
 * A new bot starts with "Show app use" on. If the caller says true or false, that wins; only a missing value becomes true.
 * A missing value reads as on everywhere (lib/bot-config-helpers.ts, the bot page), so a bot made before the setting existed
 * shows its app use too; only an explicit false, saved when its owner turned it off, hides it.
 */
export function startWithToolCallsOn<T extends Record<string, unknown>>(config: T): T & { showToolCalls: boolean } {
  return { ...config, showToolCalls: 'showToolCalls' in config ? (config.showToolCalls as boolean) : true };
}
