/**
 * GET /api/admin/avatar-sets/bot-assignable
 * Returns all active avatar sets (including hidden/assigned_only) for bot assignment.
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdminSession } from '@/lib/auth'
import { resolveBotAssignableSets } from '@/lib/avatar-catalog'

export async function GET() {
  await requireAdminSession()
  const sets = await resolveBotAssignableSets(prisma)
  return NextResponse.json(sets)
}
