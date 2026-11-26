import { NextRequest } from 'next/server'
import { GET } from '@/app/api/admin/avatar-sets/[id]/access-check/route'
import { prisma } from '@/lib/db'

jest.mock('@/lib/db', () => ({
  prisma: {
    avatarSet: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    world: { findUnique: jest.fn() },
    worldMember: { findUnique: jest.fn() },
    userAvatarGrant: { findFirst: jest.fn() },
  },
}))

jest.mock('@/lib/auth', () => ({
  requireAdminSession: jest.fn().mockResolvedValue({ userId: 'admin-1', role: 'admin' }),
}))

describe('GET /api/admin/avatar-sets/:id/access-check', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('rejects policy match if policy.worldId does not match requested worldId', async () => {
    ;(prisma.avatarSet.findUnique as jest.Mock).mockResolvedValue({
      id: 'set-1',
      name: 'VIP Set',
      lifecycle: 'active',
      visibility: 'restricted',
      availableFrom: null,
      availableUntil: null,
      scopes: [{ scopeType: 'platform', scopeId: '' }],
      policies: [
        {
          id: 'pol-1',
          action: 'select',
          subjectType: 'membership_tag',
          subjectValue: 'vip',
          worldId: 'world-A', // specifically scoped to world-A
          isActive: true,
        },
      ],
    })

    ;(prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
    })

    ;(prisma.world.findUnique as jest.Mock).mockResolvedValue({
      id: 'world-B',
      universeId: 'universe-1',
    })

    ;(prisma.worldMember.findUnique as jest.Mock).mockResolvedValue({
      tags: ['vip'],
    })

    ;(prisma.userAvatarGrant.findFirst as jest.Mock).mockResolvedValue(null)

    const req = new NextRequest('http://localhost:3000/api/admin/avatar-sets/set-1/access-check?userId=user-1&worldId=world-B')
    const res = await GET(req, { params: Promise.resolve({ id: 'set-1' }) })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.canSelect).toBe(false)
    const entitlementCheck = body.checks.find((c: any) => c.check === 'entitlement')
    expect(entitlementCheck.passed).toBe(false)
  })

  it('allows policy match if policy.worldId matches requested worldId', async () => {
    ;(prisma.avatarSet.findUnique as jest.Mock).mockResolvedValue({
      id: 'set-1',
      name: 'VIP Set',
      lifecycle: 'active',
      visibility: 'restricted',
      availableFrom: null,
      availableUntil: null,
      scopes: [{ scopeType: 'platform', scopeId: '' }],
      policies: [
        {
          id: 'pol-1',
          action: 'select',
          subjectType: 'membership_tag',
          subjectValue: 'vip',
          worldId: 'world-A',
          isActive: true,
        },
      ],
    })

    ;(prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
    })

    ;(prisma.world.findUnique as jest.Mock).mockResolvedValue({
      id: 'world-A',
      universeId: 'universe-1',
    })

    ;(prisma.worldMember.findUnique as jest.Mock).mockResolvedValue({
      tags: ['vip'],
    })

    ;(prisma.userAvatarGrant.findFirst as jest.Mock).mockResolvedValue(null)

    const req = new NextRequest('http://localhost:3000/api/admin/avatar-sets/set-1/access-check?userId=user-1&worldId=world-A')
    const res = await GET(req, { params: Promise.resolve({ id: 'set-1' }) })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.canSelect).toBe(true)
    const entitlementCheck = body.checks.find((c: any) => c.check === 'entitlement')
    expect(entitlementCheck.passed).toBe(true)
  })
})
