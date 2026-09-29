/** @jest-environment jsdom */

/**
 * The owner's first quest (quests proof slice): the room's Quests tab, Add a quest with its preview and Test run,
 * Publish into this browser, the published page with Visit / Pause, and the player's quests and badges on You and
 * the Quests pages.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import NewQuestPage from '@/app/admin/rooms/[id]/quests/new/page';
import WelcomeQuestPage from '@/app/admin/rooms/[id]/quests/welcome/page';
import { RoomQuests } from '@/app/admin/components/quests/room-quests';
import { YouBadges, YouQuests } from '@/app/admin/components/quests/you-quests';
import QuestsPage from '@/app/admin/you/quests/page';
import QuestPage from '@/app/admin/you/quests/[id]/page';
import { WorkAdventureContext, type WorkAdventureContextValue } from '@/app/admin/workadventure-context';
import { publishedFromDraft, readPublishedQuest, writePublishedQuest, EMPTY_QUEST_DRAFT, type QuestContext } from '@/lib/quests/model';
import { resetQuestLog, setQuestLog } from '@/lib/quests/quest-log';
import { DRAFT_KEY_PREFIX, scopedDraftKey } from '@/lib/drafts';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const replace = jest.fn();
let mockParams: Record<string, string> = { id: 'r-1' };
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace }),
  useParams: () => mockParams,
  usePathname: () => '/admin/rooms/r-1/quests/new',
  useSearchParams: () => new URLSearchParams(),
}));

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

// Radix's switch measures itself; jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= ResizeObserverStub;

const respond = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

const ROOM = {
  id: 'r-1',
  name: 'Lobby',
  slug: 'lobby',
  canEdit: true,
  world: { id: 'w-1', name: 'Office', slug: 'office', universe: { id: 'u-1', name: 'BAWES', slug: 'bawes' } },
};
const CONTEXT: QuestContext = {
  areas: [
    { id: 'a-1', name: 'Courtyard' },
    { id: 'a-2', name: 'Studio' },
  ],
  bots: [{ id: 'b-1', name: 'Nova' }],
  source: 'wam',
};

function route({ room = ROOM, context = CONTEXT, contextStatus = 200 }: { room?: unknown; context?: unknown; contextStatus?: number } = {}) {
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/admin/rooms/r-1') return respond(room);
    if (url === '/api/admin/rooms/r-1/quest-context') return respond(context, contextStatus);
    return respond({}, 404);
  });
}

function game(isReady: boolean, roomId?: string): WorkAdventureContextValue & { navigateToRoom: jest.Mock } {
  const wa = roomId ? ({ onInit: () => Promise.resolve(), room: { id: roomId } } as unknown as WorkAdventureContextValue['wa']) : null;
  return { wa, isReady, isLoading: false, error: null, navigateToRoom: jest.fn().mockResolvedValue(undefined) };
}

/** Names set into sentences are isolated (FSI…PDI); compare the words alone. */
const words = (text: string | null | undefined) => (text ?? '').replace(/[\u2068\u2069]/g, '');

beforeEach(() => {
  fetchMock.mockReset();
  replace.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetQuestLog();
  mockParams = { id: 'r-1' };
});

describe('Add a quest', () => {
  it('starts from the Welcome chapter and asks for the area beside Explore before it can publish', async () => {
    route();
    render(<NewQuestPage />);
    expect(await screen.findByRole('radio', { name: /Welcome chapter/ })).toHaveProperty('checked', true);
    expect(screen.getByRole('heading', { name: 'Add a quest' })).toBeTruthy();
    expect(screen.getByText('More presets later.')).toBeTruthy();

    const publish = screen.getByTestId('quest-publish');
    expect(publish).toHaveProperty('disabled', true);
    // Beside the select, and again as a link by Publish that takes you there.
    expect(screen.getAllByText('Pick an area or skip this path.')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Pick an area or skip this path.' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Area to find'));

    fireEvent.change(screen.getByLabelText('Area to find'), { target: { value: 'a-1' } });
    expect(publish).toHaveProperty('disabled', false);
    expect(screen.queryByText('Pick an area or skip this path.')).toBeNull();
  });

  it('previews the four screens as the game shows them, in its words with this room’s names, and rehearses them', async () => {
    route();
    render(<NewQuestPage />);
    fireEvent.change(await screen.findByLabelText('Area to find'), { target: { value: 'a-1' } });
    const preview = screen.getByTestId('quest-preview');
    const strip = () => words(preview.textContent);
    // The room's first bot greets newcomers unless the owner chooses otherwise, as in the game.
    expect(screen.getByRole('radio', { name: /A bot/ })).toHaveProperty('checked', true);
    expect((screen.getByLabelText('Host') as HTMLSelectElement).value).toBe('b-1');
    expect(strip()).toMatch(/Nova/);
    expect(within(preview).getAllByText('Good to meet you.').length).toBeGreaterThan(0);
    expect(within(preview).getAllByText('Welcome. Want a quick look around?').length).toBeGreaterThan(0);
    expect(strip()).toMatch(/Find the Courtyard\./);
    expect(within(preview).getAllByText(/First Hello badge/).length).toBeGreaterThan(0);
    // The quest log, the quest with Accept and Decline, then the completion, as in the game.
    expect(within(preview).getAllByText('Available').length).toBeGreaterThan(0);
    expect(within(preview).getAllByText('Accept').length).toBeGreaterThan(0);
    expect(within(preview).getAllByText('Decline').length).toBeGreaterThan(0);
    expect(within(preview).getAllByText('Quest complete').length).toBeGreaterThan(0);
    expect(within(preview).getAllByText('First Hello badge earned').length).toBeGreaterThan(0);
    expect(strip()).toMatch(/Nova · Lobby/);

    // No host: the room speaks.
    fireEvent.click(screen.getByRole('radio', { name: /No host/ }));
    expect(strip()).toMatch(/Lobby/);
    expect(strip()).not.toMatch(/Nova/);

    const status = screen.getByTestId('rehearsal-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe('');
    const screens = () => preview.querySelectorAll('[data-screen]');
    expect(screens()).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Test run' }));
    // Every screen stays in place; the others fade, and the status says the step and its words.
    expect(screens()).toHaveLength(4);
    expect(preview.querySelectorAll('[data-screen][data-dim]')).toHaveLength(3);
    expect(status.textContent).toBe('Step 1 of 4: the invitation. Welcome. Want a quick look around?');
    fireEvent.click(screen.getByRole('button', { name: 'Next: the quest log' }));
    expect(status.textContent).toBe('Step 2 of 4: the quest log. Quests');
    fireEvent.click(screen.getByRole('button', { name: 'Next: the quest' }));
    expect(status.textContent).toBe('Step 3 of 4: the quest. Meet someone');
    fireEvent.click(screen.getByRole('button', { name: 'Next: quest complete' }));
    expect(status.textContent).toMatch(/^Step 4 of 4: quest complete\./);
    fireEvent.click(screen.getByRole('button', { name: 'Finish test run' }));
    expect(status.textContent).toBe('Rehearsal only. Nothing was saved.');
    expect(preview.querySelectorAll('[data-screen][data-dim]')).toHaveLength(0);
    expect(readPublishedQuest('r-1')).toBeNull();

    // The visible label is part of the name.
    fireEvent.click(screen.getByRole('button', { name: 'AR العربية' }));
    expect(within(preview).getAllByText('أهلًا بك. هل تريد جولة سريعة؟').length).toBeGreaterThan(0);
  });

  it('publishes into this browser, forgets the draft and opens the quest', async () => {
    route();
    render(<NewQuestPage />);
    fireEvent.change(await screen.findByLabelText('Area to find'), { target: { value: 'a-2' } });
    await waitFor(() => expect(window.sessionStorage.getItem(DRAFT_KEY_PREFIX + scopedDraftKey('quest.new', 'r-1'))).not.toBeNull());
    fireEvent.click(screen.getByTestId('quest-publish'));
    expect(readPublishedQuest('r-1')).toEqual(
      expect.objectContaining({
        status: 'live',
        area: { id: 'a-2', name: 'Studio' },
        host: { kind: 'bot', id: 'b-1', name: 'Nova' },
        paths: { meet: true, explore: true, build: false },
      }),
    );
    expect(replace).toHaveBeenCalledWith('/admin/rooms/r-1/quests/welcome');
    expect(window.sessionStorage.getItem(DRAFT_KEY_PREFIX + scopedDraftKey('quest.new', 'r-1'))).toBeNull();
  });

  it('brings back what was chosen earlier in this room, and says so', async () => {
    window.sessionStorage.setItem(DRAFT_KEY_PREFIX + scopedDraftKey('quest.new', 'r-1'), JSON.stringify({ ...EMPTY_QUEST_DRAFT, areaId: 'a-2', build: true }));
    route();
    render(<NewQuestPage />);
    expect(await screen.findByTestId('draft-notice')).toBeTruthy();
    expect((screen.getByLabelText('Area to find') as HTMLSelectElement).value).toBe('a-2');
  });

  it('greets with the first bot, never picking one by name', async () => {
    route({ context: { ...CONTEXT, bots: [{ id: 'b-2', name: 'Guide' }, { id: 'b-1', name: 'Welcome' }] } });
    render(<NewQuestPage />);
    expect(((await screen.findByLabelText('Host')) as HTMLSelectElement).value).toBe('b-2');
  });

  it('offers no Explore on a map without named areas', async () => {
    route({ context: { areas: [], bots: [], source: 'none' } });
    render(<NewQuestPage />);
    expect(await screen.findByText(/No named areas on this map yet. Name one/)).toBeTruthy();
    expect(screen.queryByLabelText('Area to find')).toBeNull();
    expect(screen.getByTestId('quest-publish')).toHaveProperty('disabled', false);
    expect(screen.getByRole('radio', { name: /A bot/ })).toHaveProperty('disabled', true);
  });

  it('is only for people who can edit the room', async () => {
    route({ contextStatus: 403 });
    render(<NewQuestPage />);
    expect(await screen.findByTestId('quest-not-editor')).toBeTruthy();
  });
});

describe('The published welcome', () => {
  const live = publishedFromDraft({ ...EMPTY_QUEST_DRAFT, areaId: 'a-1', hostKind: 'bot', hostId: 'b-1' }, CONTEXT, 'live');

  function renderPage(wa = game(true)) {
    render(
      <WorkAdventureContext.Provider value={wa}>
        <WelcomeQuestPage />
      </WorkAdventureContext.Provider>,
    );
    return wa;
  }

  it('is live in this browser, and Visit takes the owner’s choices into the game', async () => {
    writePublishedQuest('r-1', live);
    route();
    const wa = renderPage();
    expect((await screen.findByTestId('quest-where')).textContent).toMatch(/Live in this browser \(prototype\)/);
    expect(screen.getByText('Live')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Visit the room/ }));
    await waitFor(() =>
      expect(wa.navigateToRoom).toHaveBeenCalledWith('/@/bawes/office/lobby#questArea=Courtyard&questHost=bot%3Abot-b-1'),
    );
    expect(screen.getByRole('link', { name: /Edit/ }).getAttribute('href')).toBe('/admin/rooms/r-1/quests/new');
  });

  it('pauses and resumes, saying what pausing means', async () => {
    writePublishedQuest('r-1', live);
    route();
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(readPublishedQuest('r-1')?.status).toBe('paused');
    expect(screen.getByText('Paused in this browser: Visit the room opens it without your choices.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(readPublishedQuest('r-1')?.status).toBe('live');
  });

  it('offers no Visit while the owner is already in the room, and never moves them', async () => {
    writePublishedQuest('r-1', live);
    route();
    const wa = renderPage(game(true, 'https://play.test/@/bawes/office/lobby'));
    expect((await screen.findByTestId('quest-here')).textContent).toMatch(/choices apply the next time you arrive here/);
    expect(screen.queryByRole('button', { name: /Visit the room/ })).toBeNull();
    expect(wa.navigateToRoom).not.toHaveBeenCalled();
  });

  it('offers Visit from another room', async () => {
    writePublishedQuest('r-1', live);
    route();
    renderPage(game(true, 'https://play.test/@/bawes/office/studio'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Visit the room/ })).toHaveProperty('disabled', false));
    expect(screen.queryByTestId('quest-here')).toBeNull();
  });

  it('cannot visit from outside the game', async () => {
    writePublishedQuest('r-1', live);
    route();
    renderPage(game(false));
    expect(await screen.findByRole('button', { name: /Visit the room/ })).toHaveProperty('disabled', true);
  });

  it('leads to Add a quest when nothing is published', async () => {
    route();
    renderPage();
    expect((await screen.findByTestId('quest-none')).getAttribute('href')).toBe('/admin/rooms/r-1/quests/new');
  });
});

describe('The room’s Quests tab', () => {
  it('explains a quest and offers to add one', async () => {
    render(<RoomQuests roomId="r-1" />);
    expect(await screen.findByTestId('room-quests-empty')).toBeTruthy();
    expect(screen.getByText('A quest is one short thing to do here.')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Add a quest/ }).getAttribute('href')).toBe('/admin/rooms/r-1/quests/new');
  });

  it('lists the published welcome with its status', async () => {
    writePublishedQuest('r-1', { ...publishedFromDraft({ ...EMPTY_QUEST_DRAFT, areaId: 'a-1' }, CONTEXT, 'paused') });
    render(<RoomQuests roomId="r-1" />);
    const row = await screen.findByTestId('room-quest-welcome');
    expect(within(row).getByRole('link', { name: 'Welcome chapter' }).getAttribute('href')).toBe('/admin/rooms/r-1/quests/welcome');
    expect(row.textContent).toMatch(/Explore this place: Courtyard/);
    expect(within(row).getByText('Paused')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Add a quest/ })).toBeNull();
  });
});

const LOG = [
  { id: 'welcome.explore', title: 'Explore this place', status: 'tracked' as const, giver: 'Nova', room: 'Lobby', objective: 'Find the Courtyard' },
  { id: 'welcome.build', title: 'Try building', status: 'accepted' as const, room: 'Lobby', objective: 'Add one thing' },
  { id: 'welcome.meet', title: 'Meet someone', status: 'done' as const, stamp: 'first-hello' as const, room: 'Lobby', objective: 'Say hi to someone' },
];

describe('Quests and badges on You', () => {
  it('before the game has sent anything: nothing in progress, no badges, a way to the quests', () => {
    render(
      <>
        <YouQuests />
        <YouBadges />
      </>,
    );
    expect(screen.getByTestId('chapter-progress').textContent).toBe('0 of 3 done');
    expect(screen.getByTestId('you-quests-note').textContent).toMatch(/Nothing in progress/);
    expect(screen.getByTestId('you-badges-empty').textContent).toBe('No badges yet. Every quest you finish earns one.');
    expect(screen.getByTestId('you-badges-more').getAttribute('href')).toBe('/admin/you/quests');
  });

  it('quests in progress on one card, earned badges on another, each badge saying which quest earned it', () => {
    render(
      <>
        <YouQuests />
        <YouBadges />
      </>,
    );
    act(() => setQuestLog(LOG));
    const quests = screen.getByTestId('you-quests');
    expect(within(quests).getByTestId('chapter-progress').textContent).toBe('1 of 3 done');
    expect(words(within(quests).getByTestId('quest-welcome.explore').textContent)).toBe('Explore this placeFind the CourtyardOn the map');
    expect(within(quests).getByTestId('quest-welcome.explore').getAttribute('href')).toBe('/admin/you/quests/welcome.explore');
    expect(within(quests).queryByTestId('quest-welcome.meet')).toBeNull();
    const badges = screen.getByTestId('you-badges');
    expect(words(within(badges).getByTestId('badge-first-hello').textContent)).toBe('First HelloFor Meet someone');
    expect(within(badges).queryByTestId('badge-explorer')).toBeNull();
    expect(badges.textContent).toMatch(/Only you can see these/);
    expect(within(badges).getByTestId('you-badges-more').textContent).toMatch(/2 more to earn/);
  });
});

describe('The Quests page and a quest’s page', () => {
  it('groups the chapter as in the game, not started included', () => {
    render(<QuestsPage />);
    act(() => setQuestLog(LOG.slice(0, 1)));
    expect(within(screen.getByTestId('quests-open')).getByTestId('quest-welcome.explore')).toBeTruthy();
    const notStarted = screen.getByTestId('quests-not-started');
    expect(within(notStarted).getByTestId('quest-welcome.meet').textContent).toMatch(/Say hi to someone/);
    expect(within(notStarted).getByTestId('quest-welcome.build')).toBeTruthy();
    expect(screen.queryByTestId('quests-done')).toBeNull();
  });

  it('shows a quest: objective as a tracker line, the map sentence, the badge it earns and what to do next', () => {
    mockParams = { id: 'welcome.explore' };
    render(<QuestPage />);
    act(() => setQuestLog(LOG));
    const page = screen.getByTestId('quest-page-welcome.explore');
    expect(words(page.textContent)).toMatch(/Nova · Lobby · 1 min/);
    expect(screen.getByTestId('quest-objective').textContent).toBe('Find the Courtyard0/1');
    expect(screen.getByTestId('quest-on-map').textContent).toBe('Your map is showing the way to this quest.');
    expect(screen.getByTestId('quest-reward').textContent).toBe('Explorer badgeNot earned yet');
    expect(screen.getByTestId('quest-next-step').textContent).toMatch(/follow the marker/);
  });

  it('a done quest shows its badge as earned; an unknown one says so', () => {
    mockParams = { id: 'welcome.meet' };
    const { unmount } = render(<QuestPage />);
    act(() => setQuestLog(LOG));
    expect(screen.getByTestId('quest-reward').textContent).toMatch(/First Hello badgeEarned/);
    expect(screen.queryByTestId('quest-next-step')).toBeNull();
    unmount();
    mockParams = { id: 'nope' };
    const missing = render(<QuestPage />);
    expect(screen.getByTestId('quest-missing')).toBeTruthy();
    missing.unmount();
    // The router hands the segment over decoded: a bare "%" is just an id that isn't a quest, not a crash.
    mockParams = { id: '%' };
    render(<QuestPage />);
    expect(screen.getByTestId('quest-missing')).toBeTruthy();
  });
});
