/**
 * The one button on a person's card for membership and roles: named for what it does, and none when you may do none.
 */
import { membershipButton, type MembershipState } from '@/lib/membership-button';

const state = (patch: Partial<MembershipState>): MembershipState => ({ status: 'none', mayInvite: false, mayGiveRoles: false, mayRemove: false, ...patch });

describe('membershipButton', () => {
  it.each([
    ['not in the universe and you may invite', { status: 'none', mayInvite: true }, { kind: 'membership', label: 'Give membership' }],
    ['an invitation is waiting and you may invite', { status: 'invited', mayInvite: true }, { kind: 'pending', label: 'Pending invite' }],
    ['a member and you may give roles', { status: 'member', mayGiveRoles: true }, { kind: 'roles', label: 'Roles' }],
    ['a member and you may give roles and remove', { status: 'member', mayGiveRoles: true, mayRemove: true }, { kind: 'roles', label: 'Roles' }],
    ['a member and you may only remove', { status: 'member', mayRemove: true }, { kind: 'membership', label: 'Membership' }],
  ] as const)('says the right thing when %s', (_name, patch, expected) => {
    expect(membershipButton(state(patch))).toEqual(expected);
  });

  it.each([
    ['no rights at all', { status: 'none' }],
    ['only giving roles, and they are not in the universe', { status: 'none', mayGiveRoles: true }],
    ['only giving roles, and an invitation is waiting', { status: 'invited', mayGiveRoles: true }],
    ['only removing, and they are not in the universe', { status: 'none', mayRemove: true }],
    ['a member and no rights', { status: 'member' }],
    ['a member and only the right to invite', { status: 'member', mayInvite: true }],
  ] as const)('has no button with %s', (_name, patch) => {
    expect(membershipButton(state(patch))).toBeNull();
  });
});
