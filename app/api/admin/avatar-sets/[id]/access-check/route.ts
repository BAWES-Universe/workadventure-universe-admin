/**
 * GET /api/admin/avatar-sets/:id/access-check?userId=...&worldId=...
 *
 * Access tester: returns whether a specific user would see this set
 * in their picker for a given world, and why/why not.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdminSession } from '@/lib/auth'

type Params = { params: { id: string } }

export async function GET(req: NextRequest, { params }: Params) {
  await requireAdminSession()
  const { searchParams } = new URL(req.url)
  const userId = searchParams.get('userId')
  const worldId = searchParams.get('worldId')

  if (!userId || !worldId) {
    return NextResponse.json({ error: 'userId and worldId are required' }, { status: 400 })
  }

  const [set, user, world] = await Promise.all([
    prisma.avatarSet.findUnique({
      where: { id: params.id },
      include: { scopes: true, policies: { where: { isActive: true } } },
    }),
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.world.findUnique({ where: { id: worldId }, select: { id: true, universeId: true } }),
  ])

  if (!set) return NextResponse.json({ error: 'Set not found' }, { status: 404 })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (!world) return NextResponse.json({ error: 'World not found' }, { status: 404 })

  const member = await prisma.worldMember.findUnique({
    where: { userId_worldId: { userId, worldId } },
    select: { tags: true },
  })
  const membershipTags = member?.tags ?? []

  const now = new Date()
  const result = {
    setId: set.id,
    setName: set.name,
    userId,
    worldId,
    membershipTags,
    lifecycle: set.lifecycle,
    visibility: set.visibility,
    availableFrom: set.availableFrom,
    availableUntil: set.availableUntil,
    checks: [] as { check: string; passed: boolean; reason: string }[],
    canSelect: false,
  }

  // Check lifecycle
  const lifecycleOk = set.lifecycle === 'active'
  result.checks.push({ check: 'lifecycle', passed: lifecycleOk, reason: lifecycleOk ? 'Set is active' : `Set is ${set.lifecycle}` })

  // Check availability window
  const windowOk =
    (!set.availableFrom || set.availableFrom <= now) &&
    (!set.availableUntil || set.availableUntil >= now)
  result.checks.push({ check: 'availability_window', passed: windowOk, reason: windowOk ? 'Within availability window' : 'Outside availability window' })

  // Check scope
  const inScope = set.scopes.some(
    (s) =>
      s.scopeType === 'platform' ||
      (s.scopeType === 'universe' && s.scopeId === world.universeId) ||
      (s.scopeType === 'world' && s.scopeId === worldId)
  )
  result.checks.push({ check: 'scope', passed: inScope, reason: inScope ? 'In scope for this world' : 'Not in scope for this world' })

  // Check visibility + entitlement
  if (set.visibility === 'public') {
    result.checks.push({ check: 'visibility', passed: true, reason: 'Public — visible to all' })
    result.canSelect = lifecycleOk && windowOk && inScope
  } else if (set.visibility === 'hidden' || set.visibility === 'assigned_only') {
    result.checks.push({ check: 'visibility', passed: false, reason: `${set.visibility} — not shown in player picker` })
    // Check for direct grant anyway
    const directGrant = await prisma.userAvatarGrant.findFirst({
      where: { userId, avatarSetId: params.id, isActive: true, grantType: 'select' },
    })
    result.checks.push({ check: 'direct_grant', passed: !!directGrant, reason: directGrant ? 'Has direct grant' : 'No direct grant' })
    result.canSelect = !!directGrant && inScope && lifecycleOk && windowOk
  } else if (set.visibility === 'restricted') {
    const policyMatch = set.policies.some((p) => {
      if (p.action !== 'select' && p.action !== 'manage') return false
      if (p.subjectType === 'everyone') return true
      if (p.subjectType === 'membership_tag') return !!p.subjectValue && membershipTags.includes(p.subjectValue)
      if (p.subjectType === 'user') return p.subjectValue === userId
      if (p.subjectType === 'email_domain') {
        if (!p.subjectValue || !user.email) return false
        const userDomain = user.email.split('@')[1]
        return userDomain === p.subjectValue
      }
      if (p.subjectType === 'subscription_plan') {
        if (!p.subjectValue) return false
        return user.subscriptionPlan === p.subjectValue
      }
      if (p.subjectType === 'external_contract') {
        if (!p.subjectValue || !user.externalContracts) return false
        return user.externalContracts.includes(p.subjectValue)
      }
      return false
    })
    const directGrant = await prisma.userAvatarGrant.findFirst({
      where: { userId, avatarSetId: params.id, isActive: true, grantType: 'select' },
    })
    const entitlementOk = policyMatch || !!directGrant
    result.checks.push({
      check: 'entitlement',
      passed: entitlementOk,
      reason: policyMatch
        ? `Matches policy (tags: [${membershipTags.join(', ')}])`
        : directGrant
        ? 'Has direct grant'
        : `No matching policy. User tags: [${membershipTags.join(', ')}]`,
    })
    result.canSelect = lifecycleOk && windowOk && inScope && entitlementOk
  }

  return NextResponse.json(result)
}
