/**
 * Map Storage integration — WAM existence check logic tests
 *
 * Verifies the dual-check guard pattern that prevents accidentally
 * overwriting existing WAM files when the cache file is cold or stale.
 * 
 * Note: We test the LOGIC contract here, not the HTTP layer.
 * The HTTP calls in lib/map-storage.ts are tested via integration tests.
 */
import { describe, it, expect } from '@jest/globals'

describe('WAM existence dual-check guard logic', () => {
  /**
   * The dual-check guard ensures we only create a WAM file if BOTH
   * the cache-based check AND the direct storage check agree the WAM
   * doesn't exist. This prevents false cache misses (after deploy, cold
   * cache, version mismatch) from triggering destructive overwrites.
   */

  it('creates WAM only when both cache and direct check agree it is missing', () => {
    // Guard function: only create if both miss
    const shouldCreateWam = (cacheExists: boolean, directExists: boolean): boolean => {
      return !cacheExists && !directExists
    }

    // Cache miss + direct miss → create WAM (truly missing)
    expect(shouldCreateWam(false, false)).toBe(true)

    // Cache miss + direct hit → don't create (cache was stale)
    expect(shouldCreateWam(false, true)).toBe(false)

    // Cache hit (regardless of direct) → don't create (already exists)
    expect(shouldCreateWam(true, false)).toBe(false)
    expect(shouldCreateWam(true, true)).toBe(false)
  })

  it('covers the four possible states exhaustively', () => {
    const shouldCreateWam = (cacheExists: boolean, directExists: boolean): boolean => {
      return !cacheExists && !directExists
    }

    // Truth table:
    // | Cache | Direct | Create |
    // |-------|--------|--------|
    // | false | false  | true  | ← WAM truly doesn't exist, create it
    // | false | true   | false | ← Cache is stale, WAM already exists
    // | true  | false  | false | ← Cache is correct, WAM exists
    // | true  | true   | false | ← WAM exists in both, skip
    const results = [
      { cache: false, direct: false, expected: true },
      { cache: false, direct: true, expected: false },
      { cache: true, direct: false, expected: false },
      { cache: true, direct: true, expected: false },
    ]

    for (const { cache, direct, expected } of results) {
      expect(shouldCreateWam(cache, direct)).toBe(expected)
    }
  })
})
