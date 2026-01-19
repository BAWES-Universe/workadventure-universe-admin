import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdminAuth } from '@/lib/admin-auth';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/database/stats
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * GET /api/bots/database/stats
 * Database monitoring - show what's bloating the DB
 * 
 * Auth: Admin
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdminAuth(request);

    // Query table stats using raw SQL
    const tables = [
      'bots_metrics',
      'bots_conversations_recent',
      'bots_memory',
      'bots_test_results',
    ];

    const stats: Record<string, any> = {};
    let totalSizeBytes = 0;
    const recommendations: string[] = [];

    // Use Prisma models for counts and dates, raw SQL for sizes
    const [metricsCount, metricsOldest, metricsNewest, metricsSize] = await Promise.all([
      prisma.botsMetric.count(),
      prisma.botsMetric.findFirst({ orderBy: { timestamp: 'asc' }, select: { timestamp: true } }),
      prisma.botsMetric.findFirst({ orderBy: { timestamp: 'desc' }, select: { timestamp: true } }),
      prisma.$queryRaw<Array<{ size_bytes: bigint }>>`
        SELECT pg_total_relation_size('bots_metrics')::bigint as size_bytes
      `.then((r) => Number((r[0] as any)?.size_bytes || 0)),
    ]);

    const [conversationsCount, conversationsOldest, conversationsNewest, conversationsSize] = await Promise.all([
      prisma.botsConversation.count(),
      prisma.botsConversation.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      prisma.botsConversation.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      prisma.$queryRaw<Array<{ size_bytes: bigint }>>`
        SELECT pg_total_relation_size('bots_conversations_recent')::bigint as size_bytes
      `.then((r) => Number((r[0] as any)?.size_bytes || 0)),
    ]);

    const [memoryCount, memoryOldest, memoryNewest, memorySize] = await Promise.all([
      prisma.botsMemory.count(),
      prisma.botsMemory.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      prisma.botsMemory.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      prisma.$queryRaw<Array<{ size_bytes: bigint }>>`
        SELECT pg_total_relation_size('bots_memory')::bigint as size_bytes
      `.then((r) => Number((r[0] as any)?.size_bytes || 0)),
    ]);

    const [testResultsCount, testResultsOldest, testResultsNewest, testResultsSize] = await Promise.all([
      prisma.botsTestResult.count(),
      prisma.botsTestResult.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      prisma.botsTestResult.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      prisma.$queryRaw<Array<{ size_bytes: bigint }>>`
        SELECT pg_total_relation_size('bots_test_results')::bigint as size_bytes
      `.then((r) => Number((r[0] as any)?.size_bytes || 0)),
    ]);

    // Process each table's stats
    const processTable = (table: string, count: number, sizeBytes: number, oldest: any, newest: any) => {
      totalSizeBytes += sizeBytes;
      const sizeMB = sizeBytes / (1024 * 1024);

      let recommendation = `OK: ${count.toLocaleString()} rows, ${sizeMB.toFixed(2)}MB`;
      if (count > 1000000 || sizeMB > 500) {
        recommendation = `Consider cleanup: ${count.toLocaleString()} rows, ${sizeMB.toFixed(2)}MB`;
        recommendations.push(`${table} table is large (${count.toLocaleString()} rows, ${sizeMB.toFixed(2)}MB). Consider cleanup.`);
      }

      stats[table] = {
        table,
        rowCount: count,
        sizeBytes,
        oldestRecord: oldest?.createdAt?.getTime() || oldest?.timestamp?.getTime() || null,
        newestRecord: newest?.createdAt?.getTime() || newest?.timestamp?.getTime() || null,
        recommendation,
      };
    };

    processTable('bots_metrics', metricsCount, metricsSize, metricsOldest, metricsNewest);
    processTable('bots_conversations_recent', conversationsCount, conversationsSize, conversationsOldest, conversationsNewest);
    processTable('bots_memory', memoryCount, memorySize, memoryOldest, memoryNewest);
    processTable('bots_test_results', testResultsCount, testResultsSize, testResultsOldest, testResultsNewest);

    // Format response
    const response: any = {
      metrics: stats.bots_metrics || {
        table: 'bots_metrics',
        rowCount: 0,
        sizeBytes: 0,
        recommendation: 'OK: 0 rows, 0MB',
      },
      conversations: stats.bots_conversations_recent || {
        table: 'bots_conversations_recent',
        rowCount: 0,
        sizeBytes: 0,
        recommendation: 'OK: 0 rows, 0MB',
      },
      memory: stats.bots_memory || {
        table: 'bots_memory',
        rowCount: 0,
        sizeBytes: 0,
        recommendation: 'OK: 0 rows, 0MB',
      },
      testResults: stats.bots_test_results || {
        table: 'bots_test_results',
        rowCount: 0,
        sizeBytes: 0,
        recommendation: 'OK: 0 rows, 0MB',
      },
      totalSizeBytes,
      totalSizeMB: totalSizeBytes / (1024 * 1024),
      recommendations,
    };

    return NextResponse.json(response, { headers: corsHeaders() });
  } catch (error: any) {
    if (error.message === 'Unauthorized: Admin authentication required') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: corsHeaders() }
      );
    }

    console.error('Error getting database stats:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
