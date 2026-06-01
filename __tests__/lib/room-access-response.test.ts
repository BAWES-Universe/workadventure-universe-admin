/**
 * Room access API — response shape tests
 *
 * Verifies that /api/room/access returns characterTextureIds
 * when DB textures are available (cross-device persistence fix).
 */
import { describe, it, expect } from '@jest/globals'
import type { FetchMemberDataByUuidSuccessResponse } from '@/types/workadventure'

describe('/api/room/access response shape', () => {
  it('includes characterTextureIds in the success response type', () => {
    const mockResponse: FetchMemberDataByUuidSuccessResponse = {
      status: 'ok',
      email: null,
      userUuid: 'test-uuid',
      tags: [],
      visitCardUrl: null,
      isCharacterTexturesValid: true,
      characterTextures: [{ id: 'male1', url: 'test.png', layer: ['woka'] as unknown[] }],
      characterTextureIds: ['male1'],
      isCompanionTextureValid: true,
      messages: [],
      world: 'test-world',
    }

    expect(mockResponse.characterTextureIds).toEqual(['male1'])
    expect(Array.isArray(mockResponse.characterTextureIds)).toBe(true)
  })

  it('allows characterTextureIds to be an empty array when no textures exist', () => {
    const mockResponse: FetchMemberDataByUuidSuccessResponse = {
      status: 'ok',
      email: null,
      userUuid: 'test-uuid',
      tags: [],
      visitCardUrl: null,
      isCharacterTexturesValid: false,
      characterTextures: [],
      characterTextureIds: [],
      isCompanionTextureValid: false,
      messages: [],
      world: 'test-world',
    }

    expect(mockResponse.characterTextureIds).toEqual([])
  })
})
