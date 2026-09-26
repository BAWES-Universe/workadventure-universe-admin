import {
  resolveTextureUrls,
  resolveCompanionTexture,
  isUserEntitledToSet,
  TextureValidationResult,
} from '@/lib/avatar-catalog-validator'

// We test the pure logic paths with a mock PrismaClient
const mockPrisma = {
  avatarSet: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
  avatarCompanion: {
    findFirst: jest.fn(),
  },
} as any

describe('resolveTextureUrls', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('returns invalid for empty texture IDs', async () => {
    const result = await resolveTextureUrls(mockPrisma, [], null, null, 'http://play.local')
    expect(result.valid).toBe(false)
    expect(result.textures).toEqual([])
  })

  it('resolves texture URLs from catalog when catalog sets exist', async () => {
    mockPrisma.avatarSet.count.mockResolvedValue(1)
    mockPrisma.avatarSet.findMany.mockResolvedValue([
      {
        layers: [
          { textureId: 'male1', name: 'Male 1', url: 'http://cdn.example.com/male1.png', layer: 'body' },
        ],
        companions: [],
      },
    ])

    const result = await resolveTextureUrls(
      mockPrisma, ['male1'], null, null, 'http://play.local'
    )

    expect(result.valid).toBe(true)
    expect(result.textures).toHaveLength(1)
    expect(result.textures[0].id).toBe('male1')
    expect(result.textures[0].url).toBe('http://cdn.example.com/male1.png')
  })

  it('marks as invalid when texture ID not found in catalog or fallback', async () => {
    mockPrisma.avatarSet.count.mockResolvedValue(1)
    mockPrisma.avatarSet.findMany.mockResolvedValue([
      {
        layers: [
          { textureId: 'male1', name: 'Male 1', url: 'http://cdn.example.com/male1.png', layer: 'body' },
        ],
        companions: [],
      },
    ])

    const result = await resolveTextureUrls(
      mockPrisma, ['nonexistent'], null, null, 'http://play.local'
    )

    expect(result.valid).toBe(false)
    expect(result.textures).toEqual([])
  })

  it('resolves multiple texture IDs correctly', async () => {
    mockPrisma.avatarSet.count.mockResolvedValue(1)
    mockPrisma.avatarSet.findMany.mockResolvedValue([
      {
        layers: [
          { textureId: 'male1', name: 'Male 1', url: 'http://cdn.example.com/male1.png', layer: 'body' },
          { textureId: 'hair5', name: 'Hair 5', url: 'http://cdn.example.com/hair5.png', layer: 'hair' },
        ],
        companions: [],
      },
    ])

    const result = await resolveTextureUrls(
      mockPrisma, ['male1', 'hair5'], null, null, 'http://play.local'
    )

    expect(result.valid).toBe(true)
    expect(result.textures).toHaveLength(2)
    expect(result.textures[0].id).toBe('male1')
    expect(result.textures[1].id).toBe('hair5')
  })

  it('resolves companion textures from catalog', async () => {
    mockPrisma.avatarSet.count.mockResolvedValue(1)
    mockPrisma.avatarSet.findMany.mockResolvedValue([
      {
        layers: [],
        companions: [
          { textureId: 'dog1', name: 'Dog', url: 'http://cdn.example.com/dog1.png' },
        ],
      },
    ])

    const result = await resolveTextureUrls(
      mockPrisma, ['dog1'], null, null, 'http://play.local'
    )

    expect(result.valid).toBe(true)
    expect(result.textures).toHaveLength(1)
    expect(result.textures[0].id).toBe('dog1')
  })

  it('prepends play service URL to relative texture URLs', async () => {
    mockPrisma.avatarSet.count.mockResolvedValue(1)
    mockPrisma.avatarSet.findMany.mockResolvedValue([
      {
        layers: [
          { textureId: 'male1', name: 'Male 1', url: 'resources/characters/male1.png', layer: 'body' },
        ],
        companions: [],
      },
    ])

    const result = await resolveTextureUrls(
      mockPrisma, ['male1'], null, null, 'http://play.local:8080'
    )

    expect(result.textures[0].url).toBe('http://play.local:8080/resources/characters/male1.png')
  })

  it('filters by scope when worldId and universeId are provided', async () => {
    mockPrisma.avatarSet.count.mockResolvedValue(1)
    mockPrisma.avatarSet.findMany.mockResolvedValue([
      {
        layers: [
          { textureId: 'world-only', name: null, url: 'http://cdn.example.com/w.png', layer: 'body' },
        ],
        companions: [],
      },
    ])

    const result = await resolveTextureUrls(
      mockPrisma, ['world-only'], 'world-123', 'universe-456', 'http://play.local'
    )

    // Verify scope filter included universe and world scopes
    expect(mockPrisma.avatarSet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scopes: {
            some: {
              OR: expect.arrayContaining([
                { scopeType: 'platform' },
                { scopeType: 'universe', scopeId: 'universe-456' },
                { scopeType: 'world', scopeId: 'world-123' },
              ]),
            },
          },
        }),
      })
    )

    expect(result.valid).toBe(true)
  })

  it('falls back to static JSON when no catalog sets exist', async () => {
    mockPrisma.avatarSet.count.mockResolvedValue(0)

    // Without catalog, it falls back to getWokaList() which reads config/woka.json
    // In test env the file may or may not exist, so we verify the code path:
    // findMany should NOT have been called (catalog was skipped)
    const _result = await resolveTextureUrls(
      mockPrisma, ['male1'], null, null, 'http://play.local'
    )

    expect(mockPrisma.avatarSet.findMany).not.toHaveBeenCalled()
  })

  it('returns undefined for name when catalog entry has no name', async () => {
    mockPrisma.avatarSet.count.mockResolvedValue(1)
    mockPrisma.avatarSet.findMany.mockResolvedValue([
      {
        layers: [
          { textureId: 'noid', name: null, url: 'http://cdn.example.com/noid.png', layer: 'body' },
        ],
        companions: [],
      },
    ])

    const result = await resolveTextureUrls(
      mockPrisma, ['noid'], null, null, 'http://play.local'
    )

    expect(result.valid).toBe(true)
    // name should be undefined (not null) because WokaDetail.name is optional string
    expect(result.textures[0].name).toBeUndefined()
  })
})

describe('resolveCompanionTexture', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('returns valid with null texture for empty ID', async () => {
    const result = await resolveCompanionTexture(mockPrisma, null, null, null, 'http://play.local')
    expect(result.valid).toBe(true)
    expect(result.texture).toBeNull()
  })

  it('finds companion in catalog', async () => {
    mockPrisma.avatarSet.count.mockResolvedValue(1)
    mockPrisma.avatarCompanion.findFirst.mockResolvedValue({
      textureId: 'dog1',
      url: 'http://cdn.example.com/dog1.png',
    })

    const result = await resolveCompanionTexture(
      mockPrisma, 'dog1', null, null, 'http://play.local'
    )

    expect(result.valid).toBe(true)
    expect(result.texture?.id).toBe('dog1')
  })

  it('marks as invalid when companion not found', async () => {
    mockPrisma.avatarSet.count.mockResolvedValue(1)
    mockPrisma.avatarCompanion.findFirst.mockResolvedValue(null)

    const result = await resolveCompanionTexture(
      mockPrisma, 'nonexistent', null, null, 'http://play.local'
    )

    expect(result.valid).toBe(false)
    expect(result.texture).toBeNull()
  })

  it('falls back to static JSON when no catalog sets', async () => {
    mockPrisma.avatarSet.count.mockResolvedValue(0)

    const _result = await resolveCompanionTexture(
      mockPrisma, 'dog1', null, null, 'http://play.local'
    )

    expect(mockPrisma.avatarCompanion.findFirst).not.toHaveBeenCalled()
  })

  it('rejects companion when user is not entitled to restricted avatar set', async () => {
    mockPrisma.avatarSet.count.mockResolvedValue(1)
    mockPrisma.avatarCompanion.findFirst.mockResolvedValue({
      textureId: 'vip_pet',
      url: 'http://cdn.example.com/vip_pet.png',
      avatarSet: {
        visibility: 'restricted',
        policies: [
          { action: 'select', subjectType: 'membership_tag', subjectValue: 'vip', isActive: true },
        ],
        userGrants: [],
      },
    })

    const result = await resolveCompanionTexture(
      mockPrisma,
      'vip_pet',
      null,
      null,
      'http://play.local',
      { userId: 'user-1', membershipTags: ['regular'] }
    )

    expect(result.valid).toBe(false)
    expect(result.texture).toBeNull()
  })

  it('allows companion when user matches entitlement policy', async () => {
    mockPrisma.avatarSet.count.mockResolvedValue(1)
    mockPrisma.avatarCompanion.findFirst.mockResolvedValue({
      textureId: 'vip_pet',
      url: 'http://cdn.example.com/vip_pet.png',
      avatarSet: {
        visibility: 'restricted',
        policies: [
          { action: 'select', subjectType: 'membership_tag', subjectValue: 'vip', isActive: true },
        ],
        userGrants: [],
      },
    })

    const result = await resolveCompanionTexture(
      mockPrisma,
      'vip_pet',
      null,
      null,
      'http://play.local',
      { userId: 'user-1', membershipTags: ['vip'] }
    )

    expect(result.valid).toBe(true)
    expect(result.texture?.id).toBe('vip_pet')
  })
})

describe('isUserEntitledToSet', () => {
  const now = new Date('2026-09-01T12:00:00Z')

  it('permits public sets within availability window', () => {
    expect(
      isUserEntitledToSet({ visibility: 'public' }, undefined, null, now)
    ).toBe(true)
  })

  it('rejects sets outside availability window', () => {
    const futureSet = {
      visibility: 'public',
      availableFrom: new Date('2026-09-02T00:00:00Z'),
    }
    expect(isUserEntitledToSet(futureSet, undefined, null, now)).toBe(false)

    const pastSet = {
      visibility: 'public',
      availableUntil: new Date('2026-08-31T00:00:00Z'),
    }
    expect(isUserEntitledToSet(pastSet, undefined, null, now)).toBe(false)
  })

  it('requires active grant for hidden or assigned_only sets', () => {
    const hiddenSet = { visibility: 'hidden', userGrants: [] }
    expect(isUserEntitledToSet(hiddenSet, { userId: 'u1' }, null, now)).toBe(false)

    const grantedSet = {
      visibility: 'hidden',
      userGrants: [{ grantType: 'select', isActive: true, expiresAt: null }],
    }
    expect(isUserEntitledToSet(grantedSet, { userId: 'u1' }, null, now)).toBe(true)

    const expiredSet = {
      visibility: 'assigned_only',
      userGrants: [
        {
          grantType: 'select',
          isActive: true,
          expiresAt: new Date('2026-08-01T00:00:00Z'),
        },
      ],
    }
    expect(isUserEntitledToSet(expiredSet, { userId: 'u1' }, null, now)).toBe(false)
  })

  it('evaluates restricted set policies correctly', () => {
    const tagPolicySet = {
      visibility: 'restricted',
      policies: [
        { action: 'select', subjectType: 'membership_tag', subjectValue: 'staff', isActive: true },
      ],
    }
    expect(
      isUserEntitledToSet(tagPolicySet, { membershipTags: ['student'] }, null, now)
    ).toBe(false)
    expect(
      isUserEntitledToSet(tagPolicySet, { membershipTags: ['staff'] }, null, now)
    ).toBe(true)

    const userPolicySet = {
      visibility: 'restricted',
      policies: [
        { action: 'select', subjectType: 'user', subjectValue: 'u-special', isActive: true },
      ],
    }
    expect(isUserEntitledToSet(userPolicySet, { userId: 'u-other' }, null, now)).toBe(false)
    expect(isUserEntitledToSet(userPolicySet, { userId: 'u-special' }, null, now)).toBe(true)

    const domainPolicySet = {
      visibility: 'restricted',
      policies: [
        { action: 'select', subjectType: 'email_domain', subjectValue: 'acme.org', isActive: true },
      ],
    }
    expect(
      isUserEntitledToSet(domainPolicySet, { userEmail: 'alice@other.com' }, null, now)
    ).toBe(false)
    expect(
      isUserEntitledToSet(domainPolicySet, { userEmail: 'alice@acme.org' }, null, now)
    ).toBe(true)

    const worldScopedSet = {
      visibility: 'restricted',
      policies: [
        {
          action: 'select',
          subjectType: 'membership_tag',
          subjectValue: 'vip',
          worldId: 'world-1',
          isActive: true,
        },
      ],
    }
    expect(
      isUserEntitledToSet(worldScopedSet, { membershipTags: ['vip'] }, 'world-2', now)
    ).toBe(false)
    expect(
      isUserEntitledToSet(worldScopedSet, { membershipTags: ['vip'] }, 'world-1', now)
    ).toBe(true)
  })
})

describe('resolveTextureUrls entitlement enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('rejects texture when user is not entitled to restricted set', async () => {
    mockPrisma.avatarSet.count.mockResolvedValue(1)
    mockPrisma.avatarSet.findMany.mockResolvedValue([
      {
        visibility: 'restricted',
        policies: [
          { action: 'select', subjectType: 'membership_tag', subjectValue: 'admin', isActive: true },
        ],
        userGrants: [],
        layers: [
          { textureId: 'admin_armor', name: 'Admin Armor', url: 'http://cdn.example.com/admin.png', layer: 'clothes' },
        ],
        companions: [],
      },
    ])

    const result = await resolveTextureUrls(
      mockPrisma,
      ['admin_armor'],
      null,
      null,
      'http://play.local',
      { userId: 'user-1', membershipTags: ['guest'] }
    )

    expect(result.valid).toBe(false)
    expect(result.textures).toEqual([])
  })

  it('accepts texture when user has matching membership tag for restricted set', async () => {
    mockPrisma.avatarSet.count.mockResolvedValue(1)
    mockPrisma.avatarSet.findMany.mockResolvedValue([
      {
        visibility: 'restricted',
        policies: [
          { action: 'select', subjectType: 'membership_tag', subjectValue: 'admin', isActive: true },
        ],
        userGrants: [],
        layers: [
          { textureId: 'admin_armor', name: 'Admin Armor', url: 'http://cdn.example.com/admin.png', layer: 'clothes' },
        ],
        companions: [],
      },
    ])

    const result = await resolveTextureUrls(
      mockPrisma,
      ['admin_armor'],
      null,
      null,
      'http://play.local',
      { userId: 'user-1', membershipTags: ['admin'] }
    )

    expect(result.valid).toBe(true)
    expect(result.textures).toHaveLength(1)
    expect(result.textures[0].id).toBe('admin_armor')
  })

  it('accepts texture from hidden set when user has an active direct grant', async () => {
    mockPrisma.avatarSet.count.mockResolvedValue(1)
    mockPrisma.avatarSet.findMany.mockResolvedValue([
      {
        visibility: 'hidden',
        policies: [],
        userGrants: [{ grantType: 'select', isActive: true, expiresAt: null }],
        layers: [
          { textureId: 'custom_skin', name: 'Custom Skin', url: 'http://cdn.example.com/custom.png', layer: 'body' },
        ],
        companions: [],
      },
    ])

    const result = await resolveTextureUrls(
      mockPrisma,
      ['custom_skin'],
      null,
      null,
      'http://play.local',
      { userId: 'user-1' }
    )

    expect(result.valid).toBe(true)
    expect(result.textures[0].id).toBe('custom_skin')
  })
})