'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Check, ChevronLeft, ChevronRight, Clock, UserCog, UserMinus, UserPlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { timeAgo } from '@/lib/time-ago';
import { useLive } from '../../hooks/use-live';
import {
  Context,
  EmptyCard,
  EntityRow,
  LoadingRows,
  Place,
  RolePills,
  SectionHeader,
  StatLine,
  StatusPill,
  VisitLine,
  count,
  countPlace,
} from '../../components/ds';
import { ProfileActions, ProfileFrame, ProfileLinks, WokaAvatar } from '../../components/profile-card';
import { inviteInGame, messageInGame, useGameCapability } from '../../components/orbit-bridge';
import { PassportSection } from '../../components/passport';
import { NowIn } from '../../components/now-in';
import { Planet } from '../../components/ds/planet-icon';
import InviteSheet, { firstUniverse, personNote, type UniverseChoice, type SentInvitation } from '../../components/invite-sheet';
import { useCurrentUniverseId } from '../../hooks/use-current-universe';
import { membershipButton } from '@/lib/membership-button';

interface WorldMembership {
  id: string;
  tags: string[];
  joinedAt: string;
  world: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    thumbnailUrl: string | null;
    universe: {
      id: string;
      slug: string;
      name: string;
    };
    _count?: {
      rooms?: number;
      members?: number;
      favorites?: number;
    };
  };
}

interface Universe {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  thumbnailUrl: string | null;
  isPublic: boolean;
  createdAt: string;
  _count?: {
    worlds?: number;
    rooms?: number;
    members?: number;
    favorites?: number;
  };
}

/** Their profile: a few words and links (stored as their visit card). */
interface VisitCard {
  id: string;
  bio: string | null;
  links: Array<{ label: string; url: string }>;
  createdAt: string;
  updatedAt: string;
}

interface User {
  id: string;
  uuid: string;
  name: string | null;
  // Contact fields are omitted unless the viewer may see them.
  email?: string | null;
  matrixChatId?: string | null;
  lastIpAddress?: string | null;
  isGuest: boolean;
  createdAt: string;
  updatedAt: string;
  visitCard: VisitCard | null;
  /** Their Woka's layers, bottom first. */
  woka?: string[];
  ownedUniverses: Universe[];
  worldMemberships: WorldMembership[];
  _count: {
    ownedUniverses: number;
    worldMemberships: number;
    bans: number;
    favorites: number;
    avatars: number;
  };
}

interface Visit {
  accessedAt: string;
}

interface Analytics {
  totalAccesses: number;
  lastVisitedByUser: Visit | null;
  lastVisitedOverall: Visit | null;
  /** Decided by identity on the server, never by comparing times. */
  youWereLast: boolean;
}

interface Access {
  id: string;
  accessedAt: string;
  ipAddress?: string | null;
  isAuthenticated: boolean;
  hasMembership: boolean;
  membershipTags: string[];
  universe: { id: string; name: string };
  world: { id: string; name: string };
  room: { id: string; name: string };
}

interface AccessHistory {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  firstAccess: string | null;
  lastAccess: string | null;
  accesses: Access[];
}

interface StarredRoom {
  id: string;
  name: string;
  favoritedAt: string;
  starCount: number;
  world: { name: string; universe: { name: string } };
}

interface CurrentUser {
  id: string;
  isSuperAdmin?: boolean;
}

/** When you and anyone were last somewhere, for VisitLine. */
function visits(analytics?: Analytics) {
  const you = analytics?.lastVisitedByUser?.accessedAt ?? null;
  const latest = analytics?.lastVisitedOverall?.accessedAt ?? null;
  return { you, latest, youWereLast: analytics?.youWereLast === true };
}

/** How you stand with them, from /api/admin/users/[id]/connect. Not available for yourself or for guests. */
type Relationship = 'none' | 'friends' | 'request_sent' | 'request_received' | 'blocked_by_me' | 'blocked_by_them';
type Connect = { available: true; relationship: Relationship; chatId: string | null };
type FriendStep = 'request' | 'accept' | 'cancel' | 'remove';

/** The one friend button for each way you can stand: its words, what a tap does, and its glyph. */
const FRIEND_BUTTON: Partial<Record<Relationship, { label: string; step: FriendStep; Icon: typeof UserPlus }>> = {
  none: { label: 'Add friend', step: 'request', Icon: UserPlus },
  request_sent: { label: 'Cancel request', step: 'cancel', Icon: X },
  request_received: { label: 'Accept request', step: 'accept', Icon: Check },
  friends: { label: 'Remove friend', step: 'remove', Icon: UserMinus },
};

const FRIEND_ERRORS: Record<string, string> = {
  not_accepting_requests: 'They aren’t taking friend requests.',
  no_shared_world: 'They only take friend requests from people who share a world with them.',
  too_many_open_requests: 'You have too many requests waiting. Try again once some are answered.',
  blocked: 'You can’t add them as a friend.',
};

/** Invite (two people and a plus) and Message (a speech bubble): plain white glyphs, no tile. */
function UsersPlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" />
      <path d="M3 21v-2a4 4 0 0 1 4 -4h4c.96 0 1.84 .338 2.53 .901" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      <path d="M16 19h6" />
      <path d="M19 16v6" />
    </svg>
  );
}

function MessageIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 9h8" />
      <path d="M8 13h6" />
      <path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z" />
    </svg>
  );
}

const linkClass = 'underline-offset-2 hover:underline [overflow-wrap:anywhere]';

/**
 * The universes you can do something about for this person: the one you are in first, then where you can give
 * membership, then where an invitation is waiting, then where they are a member; by name within each.
 */
function universeOrder(
  invitable: { id: string; name: string }[],
  taken: { id: string; name: string; status: 'member' | 'invited'; invitation: SentInvitation | null }[],
  currentId: string | null,
): UniverseChoice[] {
  const rank = (choice: UniverseChoice) => (choice.status === 'member' ? 2 : choice.status === 'invited' ? 1 : 0);
  return [...invitable.map(({ id, name }): UniverseChoice => ({ id, name })), ...taken].sort(
    (a, b) => Number(b.id === currentId) - Number(a.id === currentId) || rank(a) - rank(b) || a.name.localeCompare(b.name),
  );
}

function pickOpening(
  invitable: { id: string; name: string }[],
  taken: { id: string; name: string; status: 'member' | 'invited'; invitation: SentInvitation | null }[],
  currentId: string | null,
): UniverseChoice | undefined {
  return universeOrder(invitable, taken, currentId)[0];
}

export default function UserDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accessHistory, setAccessHistory] = useState<AccessHistory | null>(null);
  const [accessHistoryLoading, setAccessHistoryLoading] = useState(true);
  const [accessHistoryPage, setAccessHistoryPage] = useState(1);
  // Access history is only available to the person themselves and super admins.
  const [accessHistoryHidden, setAccessHistoryHidden] = useState(false);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [invitableUniverses, setInvitableUniverses] = useState<{ id: string; name: string; note: string | null }[]>([]);
  // Your universes they already belong to or have an invitation for: shown in the sheet, not pickable.
  const [takenUniverses, setTakenUniverses] = useState<{ id: string; name: string; status: 'member' | 'invited'; invitation: SentInvitation | null }[]>([]);
  const lookedUpUniverseId = useCurrentUniverseId();
  const currentUniverseId = lookedUpUniverseId ?? null;
  const searchParams = useSearchParams();
  const sheetWanted = searchParams.get('sheet') === 'membership';
  // The universe the sheet opens on, and what you may do about this person there: it decides the button
  const openingUniverse = pickOpening(invitableUniverses, takenUniverses, currentUniverseId);
  const [memberCan, setMemberCan] = useState<{ forUniverse: string; give: boolean; remove: boolean } | null>(null);
  // One button, named for what it does here: Give membership, Pending invite, Roles or Membership; none when none applies
  const here = memberCan && memberCan.forUniverse === openingUniverse?.id ? memberCan : null;
  const mayAct = !!currentUser && !!user && currentUser.id !== user.id && !user.isGuest && invitableUniverses.length + takenUniverses.length > 0;
  const button =
    !mayAct || !openingUniverse
      ? null
      : membershipButton({
          status: openingUniverse.status === 'member' ? 'member' : openingUniverse.status === 'invited' ? 'invited' : 'none',
          // Not in it, or waiting, are only listed for universes where you may invite
          mayInvite: openingUniverse.status !== 'member',
          mayGiveRoles: !!here?.give,
          mayRemove: !!here?.remove,
        });
  // From the card in the game: the sheet opens once, as soon as it is known which universe it opens on
  const sheetOpened = useRef(false);
  useEffect(() => {
    // Asked for again later (the sheet closed and the link was cleared): it opens again
    if (!sheetWanted) sheetOpened.current = false;
    if (!sheetWanted || sheetOpened.current || !button || lookedUpUniverseId === undefined) return;
    sheetOpened.current = true;
    setInviteDialogOpen(true);
  }, [sheetWanted, button, lookedUpUniverseId]);
  const [, setWorldsLoading] = useState(false);
  const [universeAnalytics, setUniverseAnalytics] = useState<Record<string, Analytics>>({});
  const [worldAnalytics, setWorldAnalytics] = useState<Record<string, Analytics>>({});
  const [starredRooms, setStarredRooms] = useState<StarredRoom[]>([]);
  const [starredRoomsLoading, setStarredRoomsLoading] = useState(false);
  // Kept with the profile it was fetched for, so a lookup for one person is never read as another's after the page moves on.
  const [connectState, setConnectState] = useState<{ forId: string; connect: Connect } | null>(null);
  const connect = connectState?.forId === id ? connectState.connect : null;
  const [friendBusy, setFriendBusy] = useState(false);
  const [friendError, setFriendError] = useState<string | null>(null);
  const [removeFriendOpen, setRemoveFriendOpen] = useState(false);
  // Invite and Message hand over to the game, so they show only when Orbit is open in a game that can take them.
  const gameCanInvite = useGameCapability('invite');
  const gameCanMessage = useGameCapability('message');
  const live = useLive();

  useEffect(() => {
    if (openingUniverse?.status !== 'member') return;
    const universeId = openingUniverse.id;
    let cancelled = false;
    (async () => {
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch(`/api/admin/universes/${universeId}/members/${id}`);
        if (!response.ok) return;
        const body = await response.json();
        if (!cancelled) setMemberCan({ forUniverse: universeId, give: (body.can?.giveRoleIds ?? []).length > 0, remove: !!body.can?.remove });
      } catch {
        // No button without an answer
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openingUniverse?.id, openingUniverse?.status, id]);

  useEffect(() => {
    checkAuth();
    fetchUser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (user) {
      fetchStarredRooms();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, id]);

  useEffect(() => {
    if (user) {
      fetchAccessHistory(accessHistoryPage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessHistoryPage, user]);

  useEffect(() => {
    if (currentUser && user && currentUser.id !== user.id) {
      fetchAvailableWorlds();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser, user]);

  useEffect(() => {
    if (!currentUser || !user || currentUser.id === user.id) {
      setConnectState(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch(`/api/admin/users/${id}/connect`);
        const data = response.ok ? await response.json() : null;
        if (!cancelled) setConnectState(data?.available ? { forId: id, connect: data as Connect } : null);
      } catch {
        if (!cancelled) setConnectState(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentUser, user, id]);

  useEffect(() => {
    if (user) {
      fetchUniverseAnalytics();
      fetchWorldAnalytics();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function checkAuth() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }
      const data = await response.json();
      setCurrentUser(data.user);
      setIsSuperAdmin(data.user?.isSuperAdmin || false);
    } catch {
      router.push('/admin/login');
    }
  }

  async function fetchUser() {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/users/${id}`);

      if (!response.ok) {
        if (response.status === 404) {
          // Gone, private or not yours: the page says so in place, with Back still there.
          setUser(null);
          return;
        }
        throw new Error('Failed to fetch user');
      }

      const data = await response.json();
      setUser(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load user');
    } finally {
      setLoading(false);
    }
  }

  async function fetchAccessHistory(page: number = 1) {
    try {
      setAccessHistoryLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/analytics/users/${id}?page=${page}&limit=10`);

      if (response.status === 403) {
        setAccessHistoryHidden(true);
        setAccessHistory(null);
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to fetch access history');
      }

      const data = await response.json();
      setAccessHistoryHidden(false);
      setAccessHistory(data);
    } catch (err) {
      console.error('Failed to fetch access history:', err);
    } finally {
      setAccessHistoryLoading(false);
    }
  }

  async function fetchAvailableWorlds() {
    if (!currentUser || !user || currentUser.id === user.id) {
      setInvitableUniverses([]);
      return;
    }

    try {
      setWorldsLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/users/${id}/worlds`);

      if (!response.ok) {
        throw new Error('Failed to fetch available worlds');
      }

      const data = await response.json();
      type Offered = { id: string; name: string; visit?: { at: string; room?: { name: string } | null; world?: { name: string } | null } | null };
      setInvitableUniverses(
        Array.isArray(data.universes)
          ? (data.universes as Offered[]).map((universe) => ({ id: universe.id, name: universe.name, note: personNote({ friend: !!data.friend, visit: universe.visit }) }))
          : [],
      );
      setTakenUniverses(Array.isArray(data.taken) ? data.taken : []);
    } catch (err) {
      console.error('Failed to fetch available worlds:', err);
      setInvitableUniverses([]);
    } finally {
      setWorldsLoading(false);
    }
  }

  async function fetchUniverseAnalytics() {
    if (!user || !user.ownedUniverses.length) return;

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const results = await Promise.all(
        user.ownedUniverses.map(async (universe) => {
          try {
            const response = await authenticatedFetch(
              `/api/admin/analytics/universes/${universe.id}`,
            );
            if (!response.ok) return null;
            const data = await response.json();
            return {
              universeId: universe.id,
              totalAccesses: data.totalAccesses || 0,
              lastVisitedByUser: data.lastVisitedByUser || null,
              lastVisitedOverall: data.lastVisitedOverall || null,
              youWereLast: data.youWereLast === true,
            };
          } catch {
            return null;
          }
        }),
      );

      setUniverseAnalytics((prev) => {
        const updated = { ...prev };
        for (const result of results) {
          if (result) {
            updated[result.universeId] = {
              totalAccesses: result.totalAccesses,
              lastVisitedByUser: result.lastVisitedByUser,
              lastVisitedOverall: result.lastVisitedOverall,
              youWereLast: result.youWereLast,
            };
          }
        }
        return updated;
      });
    } catch {
      // Ignore errors
    }
  }

  async function fetchWorldAnalytics() {
    if (!user || !user.worldMemberships.length) return;

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const results = await Promise.all(
        user.worldMemberships.map(async (membership) => {
          try {
            const response = await authenticatedFetch(
              `/api/admin/analytics/worlds/${membership.world.id}`,
            );
            if (!response.ok) return null;
            const data = await response.json();
            return {
              worldId: membership.world.id,
              totalAccesses: data.totalAccesses || 0,
              lastVisitedByUser: data.lastVisitedByUser || null,
              lastVisitedOverall: data.lastVisitedOverall || null,
              youWereLast: data.youWereLast === true,
            };
          } catch {
            return null;
          }
        }),
      );

      setWorldAnalytics((prev) => {
        const updated = { ...prev };
        for (const result of results) {
          if (result) {
            updated[result.worldId] = {
              totalAccesses: result.totalAccesses,
              lastVisitedByUser: result.lastVisitedByUser,
              lastVisitedOverall: result.lastVisitedOverall,
              youWereLast: result.youWereLast,
            };
          }
        }
        return updated;
      });
    } catch {
      // Ignore errors
    }
  }

  async function fetchStarredRooms() {
    if (!user) return;
    try {
      setStarredRoomsLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/users/${id}/starred-rooms`);
      if (response.ok) {
        const data = await response.json();
        setStarredRooms(data.rooms || []);
      }
    } catch (err) {
      console.error('Failed to fetch starred rooms:', err);
    } finally {
      setStarredRoomsLoading(false);
    }
  }

  /** Whether it worked; if not, `friendError` says why. */
  async function changeFriendship(step: FriendStep): Promise<boolean> {
    setFriendBusy(true);
    setFriendError(null);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/users/${id}/connect`, {
        method: 'POST',
        body: JSON.stringify({ action: step }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFriendError(FRIEND_ERRORS[data?.error] ?? 'That didn’t work. Try again.');
        return false;
      }
      setConnectState((current) =>
        current?.forId === id ? { ...current, connect: { ...current.connect, relationship: data.relationship as Relationship } } : current,
      );
      return true;
    } catch {
      setFriendError('That didn’t work. Try again.');
      return false;
    } finally {
      setFriendBusy(false);
    }
  }

  if (loading) {
    return <LoadingRows label="this person" rows={4} />;
  }

  if (!user) {
    return (
      <div className="grid min-w-0 gap-4">
        {error && (
          <p className="text-sm text-muted-foreground" role="alert">
            {error}
          </p>
        )}
        <EmptyCard kind="people" title="We couldn’t find this person." text="They may have left, or the link is wrong." href="/admin/users" action="See everyone" />
      </div>
    );
  }

  const name = user.name || user.email || 'Someone';
  const isSelf = currentUser?.id === user.id;
  // Guests can't accept: they have no Orbit sign-in, and signing in makes a different account.
  const canInvite = Boolean(currentUser && !isSelf && !user.isGuest && invitableUniverses.length + takenUniverses.length > 0);
  const universeChoices = universeOrder(invitableUniverses, takenUniverses, currentUniverseId);
  const waitingFor = takenUniverses.filter((universe) => universe.status === 'invited');
  const showPrivate = isSuperAdmin || isSelf;
  const bio = user.visitCard?.bio?.trim();
  const links = user.visitCard?.links ?? [];

  // The buttons on their card, in the order drawn: Invite over, Message, the friend button, then Give membership.
  const online = !isSelf && Boolean(live?.people.some((person) => person.uuid === user.uuid));
  const blocked = connect?.relationship === 'blocked_by_me' || connect?.relationship === 'blocked_by_them';
  const friendButton = connect && !blocked ? FRIEND_BUTTON[connect.relationship] : undefined;
  const pills: ReactNode[] = [];
  const pillClass = 'h-11 min-w-0 gap-2 px-3';
  // The gradient goes to the first button that starts something; undoing ones and the universe invite stay plain.
  let mainTaken = false;
  const pillVariant = (go = true) => {
    if (!go || mainTaken) return 'outline';
    mainTaken = true;
    return 'default';
  };
  if (gameCanInvite && online) {
    pills.push(
      <Button key="invite" variant={pillVariant()} className={pillClass} onClick={() => inviteInGame(user.uuid, name)}>
        <UsersPlusIcon />
        Invite over
      </Button>,
    );
  }
  if (gameCanMessage && connect?.chatId) {
    const chatId = connect.chatId;
    pills.push(
      <Button key="message" variant={pillVariant()} className={pillClass} onClick={() => messageInGame(user.uuid, name, chatId)}>
        <MessageIcon />
        Message
      </Button>,
    );
  }
  if (friendButton) {
    pills.push(
      <Button key="friend" variant={pillVariant(friendButton.step === 'request' || friendButton.step === 'accept')} className={pillClass} disabled={friendBusy} onClick={() => {
          if (friendButton.step !== 'remove') return void changeFriendship(friendButton.step);
          setFriendError(null);
          setRemoveFriendOpen(true);
        }}>
        <friendButton.Icon aria-hidden="true" />
        {friendButton.label}
      </Button>,
    );
  }
  const membershipAction = button && { label: button.label, Icon: button.kind === 'roles' ? UserCog : button.kind === 'pending' ? Clock : Planet };
  if (membershipAction) {
    pills.push(
      <Button key="member" variant={pillVariant(false)} className={pillClass} data-wide="" onClick={() => setInviteDialogOpen(true)}>
        <membershipAction.Icon aria-hidden="true" />
        <span className="truncate">{membershipAction.label}</span>
      </Button>,
    );
  }

  return (
    <div className="grid min-w-0 gap-7">
      <ProfileFrame
        headingId="person-name"
        layers={user.woka ?? []}
        name={name}
        testId="person-card"
        stats={
          <StatLine
            items={[
              user.ownedUniverses.length ? `Owns ${count(user.ownedUniverses.length, 'universe')}` : null,
              user.worldMemberships.length ? `Member of ${count(user.worldMemberships.length, 'world')}` : null,
              user.isGuest && 'Guest',
            ]}
          />
        }
        action={pills.length > 0 ? <ProfileActions count={pills.length}>{pills}</ProfileActions> : undefined}
      >
        {/* Who they are first, then where they are; on a phone the buttons come last, under these. */}
        {(bio || links.length > 0) && (
          <div className="grid min-w-0 gap-3">
            {bio && <p className="whitespace-pre-line text-sm leading-relaxed [overflow-wrap:anywhere]">{bio}</p>}
            <ProfileLinks links={links} />
          </div>
        )}
        {!isSelf && <NowIn live={live} uuid={user.uuid} />}
        {friendError && (
          <p className="text-sm text-muted-foreground" role="alert">
            {friendError}
          </p>
        )}
      </ProfileFrame>

      {/* The same passport block as on You: your own in full, someone else's only as far as they share it with you. */}
      {currentUser && (isSelf ? <PassportSection /> : <PassportSection userId={user.id} name={name} />)}

      {error && (
        <p className="text-sm text-muted-foreground" role="alert">
          {error}
        </p>
      )}

      <section className="grid min-w-0 gap-2" aria-labelledby="person-universes">
        <SectionHeader id="person-universes" title="Universes" count={user.ownedUniverses.length} />
        {user.ownedUniverses.length === 0 ? (
          <EmptyCard kind="universe" title="No universes yet." text={isSelf ? 'You don’t own a universe yet.' : `${name} doesn’t own a universe yet.`} />
        ) : (
          <div className="grid min-w-0 gap-0.5">
            {user.ownedUniverses.map((universe) => {
              const analytics = universeAnalytics[universe.id];
              const stars = universe._count?.favorites ?? 0;
              return (
                <EntityRow
                  key={universe.id}
                  href={`/admin/universes/${universe.id}`}
                  kind="universe"
                  universeId={universe.id}
                  title={universe.name}
                  context={
                    <StatLine
                      items={[
                        countPlace('world', universe._count?.worlds ?? 0, 'world'),
                        countPlace('room', universe._count?.rooms ?? 0, 'room'),
                        countPlace('people', universe._count?.members ?? 0, 'member'),
                        analytics && count(analytics.totalAccesses, 'access', 'accesses'),
                      ]}
                    />
                  }
                  meta={<VisitLine {...visits(analytics)} />}
                  aside={
                    <>
                      {stars > 0 && <span>★ {stars}</span>}
                      <StatusPill status={universe.isPublic ? 'public' : 'private'} />
                    </>
                  }
                />
              );
            })}
          </div>
        )}
      </section>

      <section className="grid min-w-0 gap-2" aria-labelledby="person-memberships">
        <SectionHeader id="person-memberships" title="Memberships" count={user.worldMemberships.length} />
        {waitingFor.length > 0 && (
          <div className="grid min-w-0 gap-0.5" data-testid="waiting-invitations">
            {waitingFor.map((universe) => (
              <EntityRow
                key={universe.id}
                href={`/admin/universes/${universe.id}/members`}
                chevron
                tone="waiting"
                kind="universe"
                universeId={universe.id}
                title={universe.name}
                context={
                  <StatLine
                    items={[
                      'Invited, waiting',
                      universe.invitation ? `by ${universe.invitation.by.you ? 'you' : universe.invitation.by.name || 'someone'}` : null,
                      universe.invitation ? timeAgo(new Date(universe.invitation.at)) : null,
                    ]}
                  />
                }
              />
            ))}
          </div>
        )}
        {user.worldMemberships.length === 0 ? (
          <EmptyCard kind="world" title="No memberships yet." text={isSelf ? 'You’re not a member of any world yet.' : `${name} isn’t a member of any world yet.`} />
        ) : (
          <div className="grid min-w-0 gap-0.5">
            {user.worldMemberships.map((membership) => {
              const analytics = worldAnalytics[membership.world.id];
              const stars = membership.world._count?.favorites ?? 0;
              return (
                <EntityRow
                  key={membership.id}
                  href={`/admin/worlds/${membership.world.id}`}
                  kind="world"
                  title={membership.world.name}
                  context={
                    <StatLine
                      items={[
                        <Place key="u" kind="universe" label={membership.world.universe.name} />,
                        countPlace('room', membership.world._count?.rooms ?? 0, 'room'),
                        countPlace('people', membership.world._count?.members ?? 0, 'member'),
                        analytics && count(analytics.totalAccesses, 'access', 'accesses'),
                      ]}
                    />
                  }
                  meta={
                    <>
                      <RolePills roles={membership.tags.length ? membership.tags : ['member']} />
                      {analytics ? (
                        <VisitLine {...visits(analytics)} />
                      ) : (
                        <StatLine items={[`Joined ${new Date(membership.joinedAt).toLocaleDateString()}`]} />
                      )}
                    </>
                  }
                  aside={stars > 0 ? `★ ${stars}` : undefined}
                />
              );
            })}
          </div>
        )}
      </section>

      <section className="grid min-w-0 gap-2" aria-labelledby="person-stars">
        <SectionHeader id="person-stars" title="Stars" count={starredRooms.length} />
        {starredRoomsLoading && starredRooms.length === 0 ? (
          <LoadingRows label="starred rooms" />
        ) : starredRooms.length === 0 ? (
          <EmptyCard kind="star" title="No stars yet." text={isSelf ? 'You haven’t starred a room yet.' : `${name} hasn’t starred a room yet.`} />
        ) : (
          <div className="grid min-w-0 gap-0.5">
            {starredRooms.map((room) => (
              <EntityRow
                key={room.id}
                href={`/admin/rooms/${room.id}`}
                kind="star"
                title={room.name}
                context={
                  <>
                    <Context parts={[{ label: room.world.universe.name, kind: 'universe' }, { label: room.world.name, kind: 'world' }]} />
                    <StatLine items={[room.favoritedAt && !Number.isNaN(Date.parse(room.favoritedAt)) && `starred ${timeAgo(new Date(room.favoritedAt))}`]} />
                  </>
                }
                aside={room.starCount > 0 ? `★ ${room.starCount}` : undefined}
              />
            ))}
          </div>
        )}
      </section>

      {showPrivate && (
        <details className="group min-w-0 rounded-2xl border border-border bg-card" data-testid="admin-details">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
            <span>{isSuperAdmin ? 'Admin details' : 'Private details'}</span>
            <ChevronRight size={16} className="text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
          </summary>
          <div className="grid min-w-0 gap-5 border-t border-border px-4 py-4">
            {!isSuperAdmin && <p className="text-xs text-muted-foreground">Only you and Orbit’s admins see this.</p>}
            <dl className="grid min-w-0 grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Email</dt>
                <dd className="mt-0.5 [overflow-wrap:anywhere]">
                  {user.email ? (
                    <a href={`mailto:${user.email}`} className={linkClass}>
                      {user.email}
                    </a>
                  ) : (
                    'None'
                  )}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Matrix ID</dt>
                <dd className="mt-0.5 font-mono text-xs [overflow-wrap:anywhere]">{user.matrixChatId || 'None'}</dd>
              </div>
              {isSuperAdmin && (
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">Last IP address</dt>
                  <dd className="mt-0.5 font-mono text-xs [overflow-wrap:anywhere]">{user.lastIpAddress || 'None'}</dd>
                </div>
              )}
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Joined</dt>
                <dd className="mt-0.5">{timeAgo(new Date(user.createdAt))}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Last updated</dt>
                <dd className="mt-0.5">{timeAgo(new Date(user.updatedAt))}</dd>
              </div>
            </dl>

            {!accessHistoryHidden && (
              <div className="grid min-w-0 gap-3" data-testid="access-history">
                <div className="grid gap-0.5">
                  <h2 className="text-sm font-semibold">Visits</h2>
                  {accessHistory && (
                    <StatLine
                      items={[
                        count(accessHistory.total ?? 0, 'access', 'accesses'),
                        accessHistory.firstAccess && `first ${new Date(accessHistory.firstAccess).toLocaleDateString()}`,
                        accessHistory.lastAccess && `last ${timeAgo(new Date(accessHistory.lastAccess))}`,
                      ]}
                    />
                  )}
                </div>
                {accessHistoryLoading && !accessHistory ? (
                  <LoadingRows label="visits" />
                ) : accessHistory && accessHistory.accesses.length > 0 ? (
                  <>
                    <ul className="grid min-w-0 gap-1">
                      {accessHistory.accesses.map((access) => (
                        <li key={access.id} className="grid min-w-0 gap-1 rounded-xl px-3 py-2.5 text-xs hover:bg-foreground/[0.04]">
                          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                            <span className="min-w-0 text-sm">
                              <Place
                                kind="universe"
                                label={
                                  <Link href={`/admin/universes/${access.universe.id}`} className={linkClass}>
                                    {access.universe.name}
                                  </Link>
                                }
                              />
                              <span className="text-muted-foreground" aria-hidden="true">
                                {' › '}
                              </span>
                              <Place
                                kind="world"
                                label={
                                  <Link href={`/admin/worlds/${access.world.id}`} className={linkClass}>
                                    {access.world.name}
                                  </Link>
                                }
                              />
                              <span className="text-muted-foreground" aria-hidden="true">
                                {' › '}
                              </span>
                              <Place
                                kind="room"
                                label={
                                  <Link href={`/admin/rooms/${access.room.id}`} className={linkClass}>
                                    {access.room.name}
                                  </Link>
                                }
                              />
                            </span>
                            <span className="shrink-0 text-muted-foreground">{timeAgo(new Date(access.accessedAt))}</span>
                          </div>
                          <div className="flex min-w-0 flex-wrap items-center gap-2 text-muted-foreground">
                            {access.hasMembership && access.membershipTags.length > 0 ? (
                              <RolePills roles={access.membershipTags} />
                            ) : (
                              <span>{access.isAuthenticated ? 'Signed in' : 'Guest'}</span>
                            )}
                            {isSuperAdmin && access.ipAddress && <span className="font-mono">{access.ipAddress}</span>}
                          </div>
                        </li>
                      ))}
                    </ul>
                    {accessHistory.totalPages > 1 && (
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <span className="text-xs text-muted-foreground">
                          {(accessHistory.page - 1) * accessHistory.limit + 1}–{Math.min(accessHistory.page * accessHistory.limit, accessHistory.total)} of{' '}
                          {accessHistory.total.toLocaleString()}
                        </span>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            className="h-9 gap-1 px-3"
                            onClick={() => setAccessHistoryPage((prev) => Math.max(1, prev - 1))}
                            disabled={accessHistoryPage === 1}
                          >
                            <ChevronLeft aria-hidden="true" />
                            Previous
                          </Button>
                          <Button
                            variant="outline"
                            className="h-9 gap-1 px-3"
                            onClick={() => setAccessHistoryPage((prev) => prev + 1)}
                            disabled={accessHistoryPage >= (accessHistory.totalPages || 1)}
                          >
                            Next
                            <ChevronRight aria-hidden="true" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">No visits yet.</p>
                )}
              </div>
            )}
          </div>
        </details>
      )}

      <AlertDialog
        open={removeFriendOpen}
        onOpenChange={(open) => {
          setRemoveFriendOpen(open);
          // Cancelling after a failure leaves no stale reason on the card.
          if (!open) setFriendError(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {name} as a friend?</AlertDialogTitle>
            <AlertDialogDescription>You’ll stop being friends. You can send them a new request later.</AlertDialogDescription>
          </AlertDialogHeader>
          {friendError && (
            <p className="text-sm text-muted-foreground" role="alert">
              {friendError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="bg-[#E96D51] text-white hover:bg-[#E96D51]/90"
              disabled={friendBusy}
              onClick={async (event) => {
                event.preventDefault();
                // On a failure the dialog stays open and says why.
                if (await changeFriendship('remove')) setRemoveFriendOpen(false);
              }}
            >
              Remove friend
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {canInvite && (
        <InviteSheet
          key={[...invitableUniverses, ...takenUniverses].map((universe) => universe.id).join(',')}
          open={inviteDialogOpen}
          onOpenChange={(next) => {
            setInviteDialogOpen(next);
            // The link from the game is spent once the sheet closes, so the next one from the game opens it again
            if (!next && sheetWanted) router.replace(`/admin/users/${id}`);
          }}
          universeId={firstUniverse(universeChoices, currentUniverseId)}
          universes={universeChoices}
          giving
          person={{ userId: id, name, woka: user.woka, notes: Object.fromEntries(invitableUniverses.map((universe) => [universe.id, universe.note])) }}
          onSent={() => {
            fetchUser();
            fetchAvailableWorlds();
          }}
        />
      )}
    </div>
  );
}
