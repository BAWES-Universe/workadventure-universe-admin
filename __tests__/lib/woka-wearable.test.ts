/**
 * "Can this person wear this here": one check for room entry, saving a pick and the Recent list. These run the real
 * rules (resolvePickerSets and the check on top of it) over a small in-memory catalog.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@/lib/db', () => ({ prisma: require('../helpers/fake-db').fakeDb }));

import { addSet, resetFakeDb, state } from '../helpers/fake-db';
import { resolvePickerSets } from '@/lib/avatar-catalog';
import { prisma } from '@/lib/db';
import { companionWearableHere, wearableHere, wearableManyHere, type WearableContext } from '@/lib/woka-wearable';

const YEAR = 365 * 24 * 3600 * 1000;
// Worlds C and D are in universe U1, world X is in U2.
const inC: WearableContext = { worldId: 'wC', universeId: 'U1', userId: 'me', membershipTags: [] };
const inD: WearableContext = { ...inC, worldId: 'wD' };
const inX: WearableContext = { ...inC, worldId: 'wX', universeId: 'U2' };
const part = (textureId: string) => ({ textureId });

beforeEach(() => {
  resetFakeDb();
  state.universes.push({ id: 'U1', name: 'Zoo' }, { id: 'U2', name: 'Museum' });
  state.worlds.push(
    { id: 'wC', name: 'World C', universeId: 'U1' },
    { id: 'wD', name: 'World D', universeId: 'U1' },
    { id: 'wX', name: 'World X', universeId: 'U2' },
  );
});

describe('wearableHere', () => {
  it('allows a part of a public set for the whole platform, and anything in the game’s own list', async () => {
    addSet({ id: 'std', layers: [part('std-y')] });
    expect(await wearableHere(['std-y'], inD)).toEqual({ wearable: true });
    expect(await wearableHere(['male1'], inD)).toEqual({ wearable: true });
    expect(await wearableHere(['std-y', 'male1'], inX)).toEqual({ wearable: true });
  });

  it('allows a world’s or a universe’s own set only there', async () => {
    addSet({ id: 'cw', layers: [part('cost-w')], scopes: [{ scopeType: 'world', scopeId: 'wC' }] });
    addSet({ id: 'cu', layers: [part('cost-u')], scopes: [{ scopeType: 'universe', scopeId: 'U1' }] });
    expect((await wearableHere(['cost-w'], inC)).wearable).toBe(true);
    expect((await wearableHere(['cost-u'], inD)).wearable).toBe(true);
    expect((await wearableHere(['cost-w'], inD)).wearable).toBe(false);
    expect((await wearableHere(['cost-u'], inX)).wearable).toBe(false);
  });

  it('says other_place and names the one world a costume belongs to', async () => {
    addSet({ id: 'cw', layers: [part('cost-w')], scopes: [{ scopeType: 'world', scopeId: 'wC' }] });
    expect(await wearableHere(['cost-w'], inD)).toEqual({ wearable: false, reason: 'other_place', placeName: 'World C' });
  });

  it('names the universe when the set belongs to a universe, and no name when it belongs to several places', async () => {
    addSet({ id: 'cu', layers: [part('cost-u')], scopes: [{ scopeType: 'universe', scopeId: 'U1' }] });
    addSet({ id: 'two', layers: [part('cost-two')], scopes: [{ scopeType: 'world', scopeId: 'wC' }, { scopeType: 'world', scopeId: 'wX' }] });
    expect(await wearableHere(['cost-u'], inX)).toEqual({ wearable: false, reason: 'other_place', placeName: 'Zoo' });
    expect(await wearableHere(['cost-two'], inD)).toEqual({ wearable: false, reason: 'other_place' });
  });

  it('says removed for a part in an archived or draft set, outside its dates, or in no set at all', async () => {
    addSet({ id: 'old', lifecycle: 'archived', layers: [part('archived-1')] });
    addSet({ id: 'draft', lifecycle: 'draft', layers: [part('draft-1')] });
    addSet({ id: 'ended', layers: [part('ended-1')], availableUntil: new Date(Date.now() - YEAR) });
    addSet({ id: 'later', layers: [part('later-1')], availableFrom: new Date(Date.now() + YEAR) });
    for (const id of ['archived-1', 'draft-1', 'ended-1', 'later-1', 'never-existed']) {
      expect(await wearableHere([id], inC)).toEqual({ wearable: false, reason: 'removed' });
    }
  });

  it('says no_access when the set is here but the person is not entitled, and allows them once they are', async () => {
    addSet({
      id: 'vip',
      visibility: 'restricted',
      layers: [part('vip-1')],
      scopes: [{ scopeType: 'world', scopeId: 'wC' }],
      policies: [{ subjectType: 'membership_tag', subjectValue: 'vip' }],
    });
    addSet({ id: 'secret', visibility: 'hidden', layers: [part('hidden-1')], scopes: [{ scopeType: 'world', scopeId: 'wC' }] });
    expect(await wearableHere(['vip-1'], inC)).toEqual({ wearable: false, reason: 'no_access' });
    expect((await wearableHere(['vip-1'], { ...inC, membershipTags: ['vip'] })).wearable).toBe(true);
    expect(await wearableHere(['hidden-1'], inC)).toEqual({ wearable: false, reason: 'no_access' });
  });

  it('allows a direct grant of a set scoped here, and an assigned_only grant scoped here, but not one scoped elsewhere', async () => {
    addSet({ id: 'gift', visibility: 'hidden', layers: [part('gift-1')], scopes: [{ scopeType: 'world', scopeId: 'wC' }] });
    addSet({ id: 'elsewhere', visibility: 'hidden', layers: [part('gift-x')], scopes: [{ scopeType: 'world', scopeId: 'wX' }] });
    addSet({ id: 'forced', visibility: 'assigned_only', layers: [part('forced-1')], scopes: [{ scopeType: 'world', scopeId: 'wC' }] });
    addSet({ id: 'forced-x', visibility: 'assigned_only', layers: [part('forced-x')], scopes: [{ scopeType: 'world', scopeId: 'wX' }] });
    state.grants.push(
      { userId: 'me', avatarSetId: 'gift', grantType: 'select', isActive: true, expiresAt: null },
      { userId: 'me', avatarSetId: 'elsewhere', grantType: 'select', isActive: true, expiresAt: null },
      { userId: 'me', avatarSetId: 'forced', grantType: 'assigned_only', isActive: true, expiresAt: null },
      { userId: 'me', avatarSetId: 'forced-x', grantType: 'assigned_only', isActive: true, expiresAt: null },
    );
    expect((await wearableHere(['gift-1'], inC)).wearable).toBe(true);
    expect((await wearableHere(['forced-1'], inC)).wearable).toBe(true);
    expect((await wearableHere(['gift-x'], inC)).wearable).toBe(false);
    expect((await wearableHere(['forced-x'], inC)).wearable).toBe(false);
    // Someone else's grant gives nothing
    expect((await wearableHere(['gift-1'], { ...inC, userId: 'other' })).wearable).toBe(false);
  });

  it('does not allow a granted set outside its dates, whether granted to select or assigned_only', async () => {
    const ended = new Date(Date.now() - YEAR);
    addSet({ id: 'g1', visibility: 'hidden', layers: [part('ended-grant')], availableUntil: ended });
    addSet({ id: 'g2', visibility: 'assigned_only', layers: [part('ended-forced')], availableUntil: ended });
    addSet({ id: 'g3', visibility: 'assigned_only', layers: [part('live-forced')], availableUntil: new Date(Date.now() + YEAR) });
    state.grants.push(
      { userId: 'me', avatarSetId: 'g1', grantType: 'select', isActive: true, expiresAt: null },
      { userId: 'me', avatarSetId: 'g2', grantType: 'assigned_only', isActive: true, expiresAt: null },
      { userId: 'me', avatarSetId: 'g3', grantType: 'assigned_only', isActive: true, expiresAt: null },
    );
    expect(await wearableHere(['ended-grant'], inC)).toEqual({ wearable: false, reason: 'removed' });
    expect(await wearableHere(['ended-forced'], inC)).toEqual({ wearable: false, reason: 'removed' });
    expect((await wearableHere(['live-forced'], inC)).wearable).toBe(true);
  });

  it('refuses an outfit when any one part fails, and reports the most telling reason: removed, then no access, then another place', async () => {
    addSet({ id: 'std', layers: [part('std-body')] });
    addSet({ id: 'cw', layers: [part('cost-w')], scopes: [{ scopeType: 'world', scopeId: 'wC' }] });
    addSet({ id: 'secret', visibility: 'hidden', layers: [part('hidden-1')], scopes: [{ scopeType: 'platform' }] });
    expect((await wearableHere(['std-body', 'cost-w'], inD)).reason).toBe('other_place');
    expect((await wearableHere(['cost-w', 'hidden-1'], inD)).reason).toBe('no_access');
    expect((await wearableHere(['cost-w', 'hidden-1', 'gone'], inD)).reason).toBe('removed');
  });

  it('checks several outfits in one go, and never allows an empty outfit', async () => {
    addSet({ id: 'std', layers: [part('std-y')] });
    expect((await wearableManyHere([['std-y'], ['nope'], []], inC)).map((result) => result.wearable)).toEqual([true, false, false]);
    expect(await wearableManyHere([], inC)).toEqual([]);
  });
});

describe('companionWearableHere', () => {
  it('uses the same rule for companions: none is fine, the game’s list and an allowed set are fine, others are not', async () => {
    addSet({ id: 'pets', layers: [], companions: [part('rex')], scopes: [{ scopeType: 'world', scopeId: 'wC' }] });
    expect((await companionWearableHere(null, inC)).wearable).toBe(true);
    expect((await companionWearableHere('dog1', inX)).wearable).toBe(true);
    expect((await companionWearableHere('rex', inC)).wearable).toBe(true);
    expect(await companionWearableHere('rex', inD)).toEqual({ wearable: false, reason: 'other_place', placeName: 'World C' });
    expect(await companionWearableHere('ghost', inD)).toEqual({ wearable: false, reason: 'removed' });
  });
});

describe('resolvePickerSets, direct grants', () => {
  it('does not offer a granted set that is scoped to another world', async () => {
    addSet({ id: 'here', visibility: 'hidden', layers: [part('here-1')], scopes: [{ scopeType: 'world', scopeId: 'wC' }] });
    addSet({ id: 'away', visibility: 'hidden', layers: [part('away-1')], scopes: [{ scopeType: 'world', scopeId: 'wX' }] });
    addSet({ id: 'uni', visibility: 'hidden', layers: [part('uni-1')], scopes: [{ scopeType: 'universe', scopeId: 'U2' }] });
    addSet({ id: 'all', visibility: 'hidden', layers: [part('all-1')], scopes: [{ scopeType: 'platform' }] });
    for (const avatarSetId of ['here', 'away', 'uni', 'all']) {
      state.grants.push({ userId: 'me', avatarSetId, grantType: 'select', isActive: true, expiresAt: null });
    }
    const sets = await resolvePickerSets({ prisma: prisma as never, worldId: 'wC', universeId: 'U1', userId: 'me', membershipTags: [] });
    expect(sets.map((set) => set.id).sort()).toEqual(['all', 'here']);
  });
});
