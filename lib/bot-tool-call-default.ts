/**
 * A new bot starts with "Show tool calls" on. If the caller says true or false, that wins; only a
 * missing value becomes true. Existing bots are never touched: a missing value on one of them still reads as off.
 */
export function startWithToolCallsOn<T extends Record<string, unknown>>(config: T): T & { showToolCalls: boolean } {
  return { ...config, showToolCalls: 'showToolCalls' in config ? (config.showToolCalls as boolean) : true };
}
