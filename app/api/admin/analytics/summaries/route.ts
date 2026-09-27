import { NextRequest, NextResponse } from 'next/server';
import { getViewer, unauthorizedResponse } from '@/lib/access-scope';
import { activitySummaries, isSummaryKind, MAX_SUMMARY_IDS } from '@/lib/activity-summaries';

/**
 * GET /api/admin/analytics/summaries?kind=rooms&ids=a,b,c
 *
 * Every card's numbers for a whole list in one request: accesses, the peak buckets, and when you and the latest
 * visitor were last there (the latest visitor by time only, never who). Up to 100 ids.
 */
export async function GET(request: NextRequest) {
  try {
    const viewer = await getViewer(request);
    if (!viewer) return unauthorizedResponse();

    const { searchParams } = new URL(request.url);
    const kind = searchParams.get('kind');
    if (!isSummaryKind(kind)) {
      return NextResponse.json({ error: 'kind must be rooms, worlds or universes' }, { status: 400 });
    }
    const ids = (searchParams.get('ids') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length > MAX_SUMMARY_IDS) {
      return NextResponse.json({ error: `At most ${MAX_SUMMARY_IDS} ids` }, { status: 400 });
    }

    return NextResponse.json({ summaries: await activitySummaries(kind, ids, viewer) });
  } catch (error) {
    console.error('Error fetching activity summaries:', error);
    return NextResponse.json({ error: 'Failed to fetch activity summaries' }, { status: 500 });
  }
}
