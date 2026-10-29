'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { authenticatedFetch } from '@/lib/client-auth';
import { PLAY_ORIGIN, isInsideFrame } from '@/lib/play-origin';
import { trackOrbitHistory } from '@/lib/orbit-history';
import {
  ORBIT_BRIDGE_CAPABILITIES,
  ORBIT_BRIDGE_VERSION,
  ORBIT_HOME_PATH,
  MAX_CHECKED_LINKS,
  parseBridgeMessage,
  type OrbitBridgeAck,
  type OrbitBridgeAckError,
  type OrbitBridgeReady,
  type OrbitCheckLinks,
  type OrbitEventTopic,
  type OrbitHistoryStep,
  type OrbitInvitePerson,
  type OrbitLinks,
  type OrbitMessagePerson,
  type OrbitOpenArtifact,
  type OrbitOpenLink,
  type OrbitProfileChanged,
  type OrbitView,
} from '@/lib/orbit-bridge';

/** Fired on `window` when the game says something changed, for pages that keep their own data. */
export const ORBIT_REFRESH_EVENT = 'orbit:refresh';
export type OrbitRefreshEventDetail = { topic: OrbitEventTopic };

/** What the game said about this visit (in `orbit-bridge-init`), for the one thing Orbit tells the game. */
let gameVisit: { roomRevision: string; capabilities: string[]; maxNameLength?: number } | null = null;

const gameVisitListeners = new Set<() => void>();

function setGameVisit(visit: typeof gameVisit) {
  // The game's answers about links belong to its visit: a new room or connection asks again.
  if (visit?.roomRevision !== gameVisit?.roomRevision) forgetLinkAnswers();
  gameVisit = visit;
  gameVisitListeners.forEach((listener) => listener());
}

/** Whether Orbit is open in a game that said it can do `capability` (for example "invite" or "message"). */
export function useGameCapability(capability: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      gameVisitListeners.add(listener);
      return () => gameVisitListeners.delete(listener);
    },
    () => Boolean(gameVisit?.capabilities.includes(capability)),
    () => false,
  );
}

function postToGame(
  build: (
    roomRevision: string,
  ) => OrbitInvitePerson | OrbitMessagePerson | OrbitCheckLinks | OrbitOpenLink | OrbitOpenArtifact | OrbitHistoryStep,
  capability: string,
): boolean {
  if (!gameVisit?.capabilities.includes(capability) || !isInsideFrame()) return false;
  window.parent.postMessage(build(gameVisit.roomRevision), PLAY_ORIGIN);
  return true;
}

/** Asks the game to invite this person over. False outside the game, or in a game that can't (no message is sent). */
export function inviteInGame(uuid: string, name: string): boolean {
  return postToGame(
    (roomRevision) => ({ type: 'orbit-invite-person', version: ORBIT_BRIDGE_VERSION, roomRevision, uuid, name }),
    'invite',
  );
}

/** Asks the game to open a chat with this person. False outside the game, or in a game that can't. */
export function messageInGame(uuid: string, name: string, chatId: string): boolean {
  return postToGame(
    (roomRevision) => ({ type: 'orbit-message-person', version: ORBIT_BRIDGE_VERSION, roomRevision, uuid, name, chatId }),
    'message',
  );
}

/** Tells the game how many steps Orbit's pages have added to the tab's history, in a game that walks back over them. */
function tellGameHistoryStep(step: number) {
  postToGame((roomRevision) => ({ type: 'orbit-history', version: ORBIT_BRIDGE_VERSION, roomRevision, step }), 'history');
}

/** How long Orbit waits for the game to say which links it can show before leaving them to open a new tab. */
const LINK_CHECK_TIMEOUT_MS = 10_000;

/** What the game said about each link this visit: true when it can show the page in its own window. */
const linkAnswers = new Map<string, boolean>();
const pendingLinkChecks = new Map<string, { urls: string[]; timer: ReturnType<typeof setTimeout> }>();
const linkListeners = new Set<() => void>();
let linkAnswersVersion = 0;
let nextLinkCheck = 0;

function settleLinks(urls: string[], openHere: readonly string[]) {
  for (const url of urls) linkAnswers.set(url, openHere.includes(url));
  linkAnswersVersion += 1;
  linkListeners.forEach((listener) => listener());
}

function forgetLinkAnswers() {
  for (const { timer } of pendingLinkChecks.values()) clearTimeout(timer);
  pendingLinkChecks.clear();
  linkAnswers.clear();
  linkAnswersVersion += 1;
  linkListeners.forEach((listener) => listener());
}

/** The game answered which links it can show (`orbit-links`). An answer for another visit, or unasked, is ignored. */
function onLinksAnswer(message: OrbitLinks) {
  const pending = pendingLinkChecks.get(message.requestId);
  if (!pending || message.roomRevision !== gameVisit?.roomRevision) return;
  clearTimeout(pending.timer);
  pendingLinkChecks.delete(message.requestId);
  // Only links Orbit asked about can open here.
  settleLinks(pending.urls, message.openHere);
}

/** Asks the game about the https links it hasn't answered for yet (an http page can't load inside the game). */
function askGameAboutLinks(urls: string[]) {
  const asked = new Set([...pendingLinkChecks.values()].flatMap((pending) => pending.urls));
  const fresh = [...new Set(urls)].filter(
    (url) => /^https:\/\//i.test(url) && url.length <= 2048 && !linkAnswers.has(url) && !asked.has(url),
  );
  for (let start = 0; start < fresh.length; start += MAX_CHECKED_LINKS) {
    const batch = fresh.slice(start, start + MAX_CHECKED_LINKS);
    nextLinkCheck += 1;
    const requestId = `links-${nextLinkCheck}`;
    const sent = postToGame(
      (roomRevision) => ({ type: 'orbit-check-links', version: ORBIT_BRIDGE_VERSION, requestId, roomRevision, urls: batch }),
      'open-link',
    );
    if (!sent) return;
    // No answer in time: these links keep opening a new tab, as before.
    const timer = setTimeout(() => {
      pendingLinkChecks.delete(requestId);
      settleLinks(batch, []);
    }, LINK_CHECK_TIMEOUT_MS);
    pendingLinkChecks.set(requestId, { urls: batch, timer });
  }
}

/**
 * Which of these links open in the game's window: the ones the game, asked when they show, said it can show. None
 * outside the game, in a game that can't, or until the game answers; those keep opening a new tab.
 */
export function useLinksOpeningInGame(urls: readonly string[]): ReadonlySet<string> {
  const canOpen = useGameCapability('open-link');
  // A new visit forgets the answers (see setGameVisit): a card still showing asks again.
  const visit = useSyncExternalStore(
    (listener) => {
      gameVisitListeners.add(listener);
      return () => gameVisitListeners.delete(listener);
    },
    () => gameVisit?.roomRevision ?? null,
    () => null,
  );
  const key = urls.join('\n');
  useEffect(() => {
    if (canOpen && visit && key) askGameAboutLinks(key.split('\n'));
  }, [canOpen, visit, key]);
  // Renders again when the game answers.
  useSyncExternalStore(
    (listener) => {
      linkListeners.add(listener);
      return () => linkListeners.delete(listener);
    },
    () => linkAnswersVersion,
    () => 0,
  );
  return new Set(canOpen ? urls.filter((url) => linkAnswers.get(url) === true) : []);
}

/**
 * Asks the game to open a link in its window, in front of Orbit, which stays as it is behind it. Only a link the game
 * said it can show; false otherwise (the link then opens a new tab as before).
 */
export function openLinkInGame(url: string): boolean {
  if (linkAnswers.get(url) !== true) return false;
  return postToGame(
    (roomRevision) => ({ type: 'orbit-open-link', version: ORBIT_BRIDGE_VERSION, roomRevision, url }),
    'open-link',
  );
}

/**
 * Asks the game to open one of your artifacts in its window, in front of Orbit (game #1474). False outside the game,
 * or in a game that can't (nothing is sent).
 */
export function openArtifactInGame(artifact: { id: string; title: string; kind: string; version: number; makerName: string }): boolean {
  return postToGame(
    (roomRevision) => ({
      type: 'orbit-open-artifact',
      version: ORBIT_BRIDGE_VERSION,
      roomRevision,
      id: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      artifactVersion: artifact.version,
      maker: artifact.makerName,
    }),
    'open-artifact',
  );
}

/** The longest name the game accepts, when Orbit is open in a game that can take a new name. */
export function gameMaxNameLength(): number | undefined {
  return gameVisit?.capabilities.includes('profile') ? gameVisit.maxNameLength : undefined;
}

/**
 * Tells the game you saved a new name, so it shows it once Orbit closes. Returns false outside the game, or in a
 * game that can't take one (the name then shows the next time the game loads).
 */
export function announceProfileName(name: string): boolean {
  if (!gameVisit?.capabilities.includes('profile') || !isInsideFrame()) return false;
  const message: OrbitProfileChanged = {
    type: 'orbit-profile-changed',
    version: ORBIT_BRIDGE_VERSION,
    roomRevision: gameVisit.roomRevision,
    name,
  };
  window.parent.postMessage(message, PLAY_ORIGIN);
  return true;
}

async function resolvePage(intent: string, params: Record<string, string> | undefined): Promise<string> {
  try {
    const response = await authenticatedFetch('/api/orbit-bridge/resolve', {
      method: 'POST',
      body: JSON.stringify({ intent, params }),
    });
    if (!response.ok) return ORBIT_HOME_PATH;
    const data = (await response.json()) as { path?: unknown };
    return typeof data.path === 'string' && data.path.startsWith('/admin') ? data.path : ORBIT_HOME_PATH;
  } catch {
    return ORBIT_HOME_PATH;
  }
}

/**
 * Orbit's end of the bridge (see lib/orbit-bridge.ts). Mounted by the shell once the session is loaded, so it only
 * says it is ready (and so only receives page requests) after sign-in has completed.
 */
export default function OrbitBridge({
  onRefresh,
  onView,
}: {
  onRefresh: () => void;
  /** The game said which view (compact or full-screen) its frame is in. */
  onView?: (view: OrbitView) => void;
}) {
  const router = useRouter();
  const roomRevision = useRef<string | null>(null);
  const onRefreshRef = useRef(onRefresh);
  const onViewRef = useRef(onView);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
    onViewRef.current = onView;
  }, [onRefresh, onView]);

  useEffect(() => {
    if (!isInsideFrame()) return;
    // Orbit's pages share the tab's history with the game: the game hears how many steps they add (#1556).
    const history = trackOrbitHistory();
    const stopHistory = history.subscribe(tellGameHistoryStep);
    const post = (message: OrbitBridgeReady | OrbitBridgeAck) => window.parent.postMessage(message, PLAY_ORIGIN);
    const ack = (requestId: string, revision: string, error?: OrbitBridgeAckError) =>
      post({
        type: 'orbit-bridge-ack',
        version: ORBIT_BRIDGE_VERSION,
        requestId,
        roomRevision: revision,
        ok: !error,
        ...(error ? { error } : {}),
      });

    const onMessage = (event: MessageEvent<unknown>) => {
      const parsed = parseBridgeMessage(event, { origin: PLAY_ORIGIN, source: window.parent });
      if (!parsed) return;

      if (parsed.kind === 'init') {
        roomRevision.current = parsed.message.roomRevision;
        setGameVisit({
          roomRevision: parsed.message.roomRevision,
          capabilities: parsed.message.capabilities,
          maxNameLength: parsed.message.maxNameLength,
        });
        if (parsed.message.view) onViewRef.current?.(parsed.message.view);
        tellGameHistoryStep(history.step);
        return;
      }

      if (parsed.kind === 'view') {
        onViewRef.current?.(parsed.message.view);
        return;
      }

      if (parsed.kind === 'links') {
        onLinksAnswer(parsed.message);
        return;
      }

      const { requestId, roomRevision: revision } = parsed.message;
      if (roomRevision.current === null) return ack(requestId, revision, 'not-ready');
      // A request from an earlier room or connection is refused.
      if (revision !== roomRevision.current) return ack(requestId, revision, 'stale-revision');

      if (parsed.kind === 'navigate') {
        const { intent, params } = parsed.message;
        void resolvePage(intent, params).then((path) => {
          // The room may have changed while Orbit was resolving the page.
          if (roomRevision.current !== revision) return ack(requestId, revision, 'stale-revision');
          router.push(path);
          ack(requestId, revision);
        });
        return;
      }

      // A refresh hint only: fetch again, trust nothing in the message.
      const detail: OrbitRefreshEventDetail = { topic: parsed.message.topic };
      onRefreshRef.current();
      router.refresh();
      window.dispatchEvent(new CustomEvent(ORBIT_REFRESH_EVENT, { detail }));
      ack(requestId, revision);
    };

    window.addEventListener('message', onMessage);
    post({ type: 'orbit-bridge-ready', version: ORBIT_BRIDGE_VERSION, capabilities: ORBIT_BRIDGE_CAPABILITIES });
    return () => {
      window.removeEventListener('message', onMessage);
      stopHistory();
      setGameVisit(null);
    };
  }, [router]);

  return null;
}
