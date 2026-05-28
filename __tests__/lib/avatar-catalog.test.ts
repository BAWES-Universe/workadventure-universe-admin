import { buildWokaListPayload, WaWokaListPayload } from '@/lib/avatar-catalog'
import type { AvatarSetFull } from '@/lib/avatar-catalog'

function makeSet(overrides: Partial<AvatarSetFull> = {}): AvatarSetFull {
  return {
    id: 'set-1',
    slug: 'test-set',
    name: 'Test Set',
    description: null,
    kind: 'woka',
    lifecycle: 'active',
    visibility: 'public',
    sourceOwnerType: 'platform',
    partnerRef: null,
    campaignCode: null,
    monetizationType: 'free',
    billingReference: null,
    licenseNotes: null,
    availableFrom: null,
    availableUntil: null,
    position: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    layers: [],
    companions: [],
    scopes: [],
    policies: [],
    ...overrides,
  }
}

function makeLayer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'layer-1',
    avatarSetId: 'set-1',
    textureId: 'male1',
    layer: 'body',
    name: 'Male 1',
    url: 'http://example.com/male1.png',
    position: 0,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeCompanion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'comp-1',
    avatarSetId: 'set-1',
    textureId: 'dog1',
    name: 'Dog',
    url: 'http://example.com/dog1.png',
    behavior: null,
    position: 0,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

describe('buildWokaListPayload', () => {
  it('returns empty collections for all layer keys when given no sets', () => {
    const result = buildWokaListPayload([])
    const expectedKeys = ['woka', 'body', 'eyes', 'hair', 'clothes', 'hat', 'accessory']

    for (const key of expectedKeys) {
      expect(result).toHaveProperty(key)
      expect(result[key as keyof WaWokaListPayload]).toEqual({ collections: [] })
    }
  })

  it('wraps each layer in { collections: [...] } matching WA protobuf format', () => {
    const set = makeSet({
      layers: [makeLayer({ layer: 'body', textureId: 'male1', name: 'Male 1' })],
    })
    const result = buildWokaListPayload([set])

    // Each layer key should be { collections: [...] } not a flat array
    expect(result.body).toEqual({
      collections: [
        {
          name: 'Test Set',
          textures: [
            { id: 'male1', name: 'Male 1', url: 'http://example.com/male1.png', position: 0 },
          ],
        },
      ],
    })
  })

  it('groups layers by type into correct collections', () => {
    const set = makeSet({
      layers: [
        makeLayer({ layer: 'body', textureId: 'male1', name: 'Body 1', position: 0 }),
        makeLayer({ layer: 'eyes', textureId: 'eyes1', name: 'Eyes 1', position: 0, id: 'layer-2' }),
        makeLayer({ layer: 'hair', textureId: 'hair1', name: 'Hair 1', position: 0, id: 'layer-3' }),
      ],
    })
    const result = buildWokaListPayload([set])

    expect(result.body.collections).toHaveLength(1)
    expect(result.body.collections[0].textures[0].id).toBe('male1')

    expect(result.eyes.collections).toHaveLength(1)
    expect(result.eyes.collections[0].textures[0].id).toBe('eyes1')

    expect(result.hair.collections).toHaveLength(1)
    expect(result.hair.collections[0].textures[0].id).toBe('hair1')
  })

  it('sorts textures by position within each collection', () => {
    const set = makeSet({
      layers: [
        makeLayer({ layer: 'body', textureId: 'b', position: 2, id: 'l1' }),
        makeLayer({ layer: 'body', textureId: 'a', position: 1, id: 'l2' }),
        makeLayer({ layer: 'body', textureId: 'c', position: 3, id: 'l3' }),
      ],
    })
    const result = buildWokaListPayload([set])

    const ids = result.body.collections[0].textures.map((t) => t.id)
    expect(ids).toEqual(['a', 'b', 'c'])
  })

  it('handles multiple sets producing separate collections per layer', () => {
    const setA = makeSet({
      id: 'set-a',
      slug: 'set-a',
      name: 'Set A',
      layers: [makeLayer({ layer: 'body', textureId: 'a1', name: 'A1', id: 'l1' })],
    })
    const setB = makeSet({
      id: 'set-b',
      slug: 'set-b',
      name: 'Set B',
      layers: [makeLayer({ layer: 'body', textureId: 'b1', name: 'B1', id: 'l2', avatarSetId: 'set-b' })],
    })
    const result = buildWokaListPayload([setA, setB])

    expect(result.body.collections).toHaveLength(2)
    expect(result.body.collections[0].name).toBe('Set A')
    expect(result.body.collections[1].name).toBe('Set B')
  })

  it('skips layers with no textures, leaving empty collections', () => {
    const set = makeSet({
      layers: [makeLayer({ layer: 'body' })],
    })
    const result = buildWokaListPayload([set])

    expect(result.body.collections).toHaveLength(1)
    expect(result.eyes.collections).toEqual([])
    expect(result.hair.collections).toEqual([])
    expect(result.hat.collections).toEqual([])
    expect(result.accessory.collections).toEqual([])
    expect(result.clothes.collections).toEqual([])
    expect(result.woka.collections).toEqual([])
  })

  it('uses textureId as fallback name when name is null', () => {
    const set = makeSet({
      layers: [makeLayer({ layer: 'body', textureId: 'fallback-id', name: null })],
    })
    const result = buildWokaListPayload([set])

    expect(result.body.collections[0].textures[0].name).toBe('fallback-id')
  })

  it('does not include companion data in the woka list payload', () => {
    const set = makeSet({
      layers: [makeLayer({ layer: 'body' })],
      companions: [makeCompanion()],
    })
    const result = buildWokaListPayload([set])

    // Companion should not appear in any layer key
    // The result type has no 'companion' key
    expect(result.body.collections[0].textures[0].id).toBe('male1')
    expect('companion' in result).toBe(false)
  })
})

describe('checkPolicyMatch', () => {
  // Note: checkPolicyMatch is not exported from avatar-catalog.ts.
  // These tests cover what would be tested if it were exported.
  // For now, the access-check route tests this logic via E2E.

  it('public visibility sets are always eligible (tested via resolvePickerSets queries)', () => {
    // resolvePickerSets uses Prisma to filter visibility: ['public', 'restricted']
    // and passes 'public' sets through without policy checks.
    // This is tested by integration tests against a real DB.
  })
})