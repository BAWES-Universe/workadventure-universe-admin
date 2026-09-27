/**
 * Answer a batched `/api/admin/analytics/summaries?kind=…&ids=…` request the way the server does: one entry per id
 * asked for, from `summaryFor(id)` (undefined leaves that id out).
 */
export function summariesBody(url: string, summaryFor: (id: string) => unknown): { summaries: Record<string, unknown> } {
  const ids = (new URL(url, 'http://orbit.test').searchParams.get('ids') ?? '').split(',').filter(Boolean);
  const summaries: Record<string, unknown> = {};
  for (const id of ids) {
    const summary = summaryFor(id);
    if (summary !== undefined) summaries[id] = summary;
  }
  return { summaries };
}

export const isSummariesUrl = (url: string) => url.startsWith('/api/admin/analytics/summaries');
