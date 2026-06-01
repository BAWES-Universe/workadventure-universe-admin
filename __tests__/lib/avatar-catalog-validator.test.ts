import { resolveTextureUrls, resolveCompanionTexture, TextureValidationResult } from '@/lib/avatar-catalog-validator'

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

  it('returns valid false with null texture for empty ID (triggers DB fallback)', async () => {
    const result = await resolveCompanionTexture(mockPrisma, null, null, null, 'http://play.local')
    expect(result.valid).toBe(false)
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
})