/**
 * The one button on a person's card (in Orbit and in the game) for membership and roles, named for what it does here.
 * No button when you may do none of it.
 */
export type MembershipButtonKind = 'membership' | 'pending' | 'roles';

export interface MembershipButton {
  kind: MembershipButtonKind;
  label: 'Give membership' | 'Pending invite' | 'Roles' | 'Membership';
}

export interface MembershipState {
  /** Where they stand in the universe: not in it, an invitation waiting, or a member. */
  status: 'none' | 'invited' | 'member';
  /** You may invite people (and take back an invitation) in this universe. */
  mayInvite: boolean;
  /** You may give or take roles from them. */
  mayGiveRoles: boolean;
  /** You may take them out of the universe. */
  mayRemove: boolean;
}

export function membershipButton(state: MembershipState): MembershipButton | null {
  if (state.status === 'none') return state.mayInvite ? { kind: 'membership', label: 'Give membership' } : null;
  if (state.status === 'invited') return state.mayInvite ? { kind: 'pending', label: 'Pending invite' } : null;
  if (state.mayGiveRoles) return { kind: 'roles', label: 'Roles' };
  // Only invite and remove: Membership, where the sheet offers taking them out
  return state.mayRemove ? { kind: 'membership', label: 'Membership' } : null;
}
