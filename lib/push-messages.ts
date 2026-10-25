import { sendPush, sendPushOnceADay } from '@/lib/push';

/**
 * The notifications Orbit sends about people and memberships (game #863), worded as the approved mock: a name as
 * the title and one line. Each is sent without waiting, so whatever caused it answers as fast as before.
 */

const someone = (name: string | null | undefined) => name?.trim() || 'Someone';

function inBackground(sending: Promise<unknown>) {
  void sending.catch(() => undefined);
}

/** "Ali · wants to be friends", to the person asked. */
export function notifyFriendRequest(to: { id: string }, from: { uuid: string; name: string | null }) {
  inBackground(
    sendPushOnceADay(to.id, 'friendRequests', { title: someone(from.name), body: 'wants to be friends', tag: `friend-request:${from.uuid}` }),
  );
}

/** "Sara · accepted your friend request", to the person who asked. Once per person. */
export function notifyFriendAccepted(to: { id: string }, from: { uuid: string; name: string | null }) {
  inBackground(
    sendPushOnceADay(to.id, 'friendRequests', {
      title: someone(from.name),
      body: 'accepted your friend request',
      tag: `friend-accepted:${from.uuid}`,
    }),
  );
}

/** "BAWES · You're invited to become a member", to the person invited. */
export function notifyInvitation(to: { id: string }, universe: { id: string; name: string }) {
  inBackground(
    sendPush(
      to.id,
      'memberships',
      { title: universe.name, body: "You're invited to become a member", tag: `membership:${universe.id}` },
      { ttl: 3 * 24 * 60 * 60 },
    ),
  );
}

/** "BAWES · You're now Editor", to the person given the role. */
export function notifyRoleGiven(to: { id: string }, universe: { id: string; name: string }, roleName: string) {
  inBackground(
    sendPush(
      to.id,
      'memberships',
      { title: universe.name, body: `You're now ${roleName}`, tag: `membership:${universe.id}` },
      { ttl: 3 * 24 * 60 * 60 },
    ),
  );
}
