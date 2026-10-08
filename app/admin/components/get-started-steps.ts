import type { Collection } from '../hooks/use-collection';

/** What Get started needs to know, however the page got it (You has the lists already; Orbit reads its own). */
export interface GetStartedProgress {
  profileComplete: boolean | null;
  ownsUniverse: boolean;
  ownsWorld: boolean;
  sentInvitation: boolean;
  hasStar: boolean;
  /** Where to invite people: the members of a world you run, when there is one. */
  inviteHref: string | null;
  /** Where "Create a world" leads: straight to your universe when you have one. */
  newWorldHref: string;
}

export interface GetStartedStep {
  done: boolean;
  title: string;
  text: string;
  /** Where the step leads; none while an earlier step has to come first. */
  href?: string;
}

interface ProgressMine {
  universes?: number;
  worlds?: number;
  stars?: number;
  ownedWorlds?: number;
  invitationsSent?: number;
}

/**
 * The real thing ticks each step (your profile, a universe you own, a world in it, an invitation you sent, a star),
 * never just being a member of someone else's world. The counts from the session stand in until a list has loaded.
 */
export function deriveProgress(input: {
  mine: ProgressMine | null | undefined;
  profileComplete: boolean | null;
  universes: Collection<{ id: string }>;
  memberships: Collection<{ tags: string[]; isUniverseOwner?: boolean; world: { id: string } }>;
  stars: Collection<unknown>;
}): GetStartedProgress {
  const { mine, profileComplete, universes, memberships, stars } = input;
  const ownsUniverse = universes.status === 'ready' ? universes.items.length > 0 : (mine?.universes ?? 0) > 0;
  const hasStar = stars.status === 'ready' ? stars.items.length > 0 : (mine?.stars ?? 0) > 0;
  // A world you run (you own its universe, or you're its admin): where "Invite a member" leads.
  const runWorld =
    memberships.status === 'ready'
      ? memberships.items.find((membership) => membership.isUniverseOwner || membership.tags.includes('admin'))
      : undefined;
  const ownsWorld = (mine?.ownedWorlds ?? 0) > 0 || Boolean(runWorld?.isUniverseOwner);
  const sentInvitation = (mine?.invitationsSent ?? 0) > 0;
  // With one universe, "Create a world" goes straight to it; with several, the form asks which.
  const onlyUniverse =
    universes.status === 'ready' && universes.items.length === 1 && (mine?.universes ?? 1) === 1 ? universes.items[0] : null;
  const newWorldHref = onlyUniverse ? `/admin/worlds/new?universeId=${encodeURIComponent(onlyUniverse.id)}` : '/admin/worlds/new';
  return {
    profileComplete,
    ownsUniverse,
    ownsWorld,
    sentInvitation,
    hasStar,
    inviteHref: runWorld ? `/admin/worlds/${runWorld.world.id}?tab=members` : null,
    newWorldHref,
  };
}

export function getStartedSteps(progress: GetStartedProgress): GetStartedStep[] {
  const { profileComplete, ownsUniverse, ownsWorld, sentInvitation, hasStar, inviteHref, newWorldHref } = progress;
  return [
    { done: profileComplete === true, title: 'Set up your profile', text: 'A few words and your links, so people know who they’re meeting.', href: '/admin/you?edit=profile' },
    { done: ownsUniverse, title: 'Create your universe', text: 'Your own corner of the Universe, to hold your worlds.', href: '/admin/universes/new?next=world' },
    {
      done: ownsWorld,
      title: 'Create a world',
      text: ownsUniverse ? 'A world in your universe. You’re its admin.' : 'After your universe.',
      href: ownsUniverse ? newWorldHref : undefined,
    },
    {
      done: sentInvitation,
      title: 'Invite a member',
      text: inviteHref ? 'Make someone a member, editor or admin of your world.' : 'After your world.',
      href: inviteHref ?? undefined,
    },
    { done: hasStar, title: 'Star a room you like', text: 'Keep a way back to it, one tap from a visit.', href: '/admin/discover/rooms' },
  ];
}
