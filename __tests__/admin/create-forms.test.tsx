/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import NewWorldPage from '@/app/admin/worlds/new/page';
import NewUniversePage from '@/app/admin/universes/new/page';
import NewRoomPage from '@/app/admin/rooms/new/page';
import { AdminBootstrapProvider, type AdminBootstrap } from '@/app/admin/admin-bootstrap-context';
import { DRAFT_KEY_PREFIX, FORM_DRAFT_VERSION, readDraft, upgradeFormDraft } from '@/lib/drafts';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

let search = new URLSearchParams();
const replace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace, back: jest.fn(), prefetch: jest.fn() }),
  useSearchParams: () => search,
}));

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

jest.mock('@/components/templates/TemplateLibrary', () => ({
  TemplateLibrary: () => <div data-testid="template-library" />,
}));
jest.mock('@/components/templates/TemplateDetail', () => ({
  TemplateDetail: () => <div data-testid="template-detail" />,
}));

// Radix's checkbox measures itself; jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= ResizeObserverStub;

const ok = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

function route(routes: Record<string, unknown>, created: unknown = { id: 'new-id' }) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return ok(created);
    const path = url.split('?')[0];
    if (path === '/api/auth/me') return ok({ user: { id: 'me' } });
    return ok(routes[path] ?? {});
  });
}

function posted(path: string) {
  const call = fetchMock.mock.calls.find(([url, init]) => url === path && init?.method === 'POST');
  return call ? JSON.parse(call[1].body) : null;
}

const UNIVERSE_A = { id: 'ua', name: 'Alpha', slug: 'alpha' };
const UNIVERSE_B = { id: 'ub', name: 'Beta', slug: 'beta' };

beforeEach(() => {
  fetchMock.mockReset();
  replace.mockReset();
  search = new URLSearchParams();
  window.sessionStorage.clear();
});

describe('New world without a universe in the address', () => {
  it('loads the universes you own', async () => {
    route({ '/api/admin/universes': { universes: [UNIVERSE_A] } });
    render(<NewWorldPage />);
    await screen.findByRole('link', { name: 'Alpha' });
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/admin/universes?scope=my&limit=100')).toBe(true);
  });

  it('with none, leads to creating a universe that then continues to the world', async () => {
    route({ '/api/admin/universes': { universes: [] } });
    render(<NewWorldPage />);
    const empty = await screen.findByTestId('world-needs-universe');
    expect(empty.getAttribute('href')).toBe('/admin/universes/new?next=world');
    expect(screen.queryByRole('button', { name: 'Create world' })).toBeNull();
    expect(screen.queryByText(/Universe ID is required/)).toBeNull();
  });

  it('with one, chooses it without asking', async () => {
    route({ '/api/admin/universes': { universes: [UNIVERSE_A] } });
    render(<NewWorldPage />);
    await screen.findByRole('link', { name: 'Alpha' });
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Head Office' } });
    expect(screen.getByText('/@/alpha/head-office/…')).toBeTruthy();
    const create = screen.getByRole('button', { name: 'Create world' });
    expect((create as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin/worlds/new-id'));
    expect(posted('/api/admin/worlds')).toMatchObject({ universeId: 'ua', name: 'Head Office', slug: 'head-office' });
    expect(posted('/api/admin/worlds')).not.toHaveProperty('addressEdited');
  });

  it('with several, asks which one', async () => {
    route({ '/api/admin/universes': { universes: [UNIVERSE_A, UNIVERSE_B] } });
    render(<NewWorldPage />);
    const beta = await screen.findByRole('radio', { name: /Beta/ });
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Studio' } });
    expect((screen.getByRole('button', { name: 'Create world' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(beta);
    expect((beta as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Create world' }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(posted('/api/admin/worlds')).toMatchObject({ universeId: 'ub', slug: 'studio' });
  });

  it('keeps a universe from the address selected, with no picker', async () => {
    search = new URLSearchParams('universeId=ub');
    route({ '/api/admin/universes': { universes: [UNIVERSE_A, UNIVERSE_B] } });
    render(<NewWorldPage />);
    await screen.findByRole('link', { name: 'Beta' });
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('says so when the universe in the address is not yours, instead of loading forever', async () => {
    search = new URLSearchParams('universeId=someone-elses');
    route({ '/api/admin/universes': { universes: [UNIVERSE_A] } });
    render(<NewWorldPage />);
    expect((await screen.findByTestId('universe-not-yours')).textContent).toContain('Choose one of yours');
    expect(screen.queryByText(/Loading universe information/)).toBeNull();
  });

  it('offers a retry when the universe cannot be loaded at all', async () => {
    search = new URLSearchParams('universeId=ua');
    fetchMock.mockImplementation((url: string) =>
      url === '/api/auth/me' ? ok({ user: { id: 'me' } }) : Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) }),
    );
    render(<NewWorldPage />);
    expect(await screen.findByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.queryByText(/Loading universe information/)).toBeNull();
    // No half-usable form under the error.
    expect(screen.queryByLabelText(/Name/)).toBeNull();
  });

  it('shows no form when your universes cannot be loaded', async () => {
    fetchMock.mockImplementation((url: string) =>
      url === '/api/auth/me' ? ok({ user: { id: 'me' } }) : Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
    );
    render(<NewWorldPage />);
    expect(await screen.findByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.queryByLabelText(/Name/)).toBeNull();
  });
});

describe('New universe on the way to a world', () => {
  async function create() {
    route({});
    render(<NewUniversePage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/me'));
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Mine' } });
    // The owner comes from /api/auth/me; wait until it's set before submitting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(screen.getByRole('button', { name: 'Create universe' }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
  }

  it('continues to the new world in it when asked to', async () => {
    search = new URLSearchParams('next=world');
    await create();
    expect(replace).toHaveBeenCalledWith('/admin/worlds/new?universeId=new-id');
  });

  it('otherwise opens the universe, as before', async () => {
    await create();
    expect(replace).toHaveBeenCalledWith('/admin/universes/new-id');
    expect(posted('/api/admin/universes')).toMatchObject({ name: 'Mine', slug: 'mine', ownerId: 'me' });
  });
});

describe('New room without a world in the address', () => {
  const W1 = { id: 'w1', name: 'Office', slug: 'office', universe: { id: 'ua', name: 'Alpha', slug: 'alpha' } };
  const W2 = { id: 'w2', name: 'Park', slug: 'park', universe: { id: 'ub', name: 'Beta', slug: 'beta' } };

  it('offers the worlds you can add rooms to', async () => {
    route({ '/api/admin/worlds/managed': { worlds: [W1, W2] } });
    render(<NewRoomPage />);
    fireEvent.click(await screen.findByRole('radio', { name: /Park/ }));
    expect(await screen.findByRole('link', { name: 'Park' })).toBeTruthy();
    expect(screen.queryByText(/Rooms must be created from a world detail page/)).toBeNull();
  });

  it('with none, leads to creating a world', async () => {
    route({ '/api/admin/worlds/managed': { worlds: [] } });
    render(<NewRoomPage />);
    expect((await screen.findByTestId('room-needs-world')).getAttribute('href')).toBe('/admin/worlds/new');
  });
});

describe('Public and Featured', () => {
  const hint = (control: HTMLElement) => document.getElementById(control.getAttribute('aria-describedby') ?? '')?.textContent;
  const asSuperAdmin = (children: React.ReactNode) => {
    const bootstrap = {
      version: 1,
      user: { id: 'me', uuid: 'me', name: 'Me', email: null, tags: [], isSuperAdmin: true },
      stats: { universes: 0, worlds: 0, rooms: 0, users: 0 },
    } satisfies AdminBootstrap;
    return <AdminBootstrapProvider value={bootstrap}>{children}</AdminBootstrapProvider>;
  };

  it('say what they do; Featured only for super admins', async () => {
    route({});
    const { unmount } = render(<NewUniversePage />);
    const isPublic = screen.getByRole('switch', { name: 'Public' });
    expect(isPublic.getAttribute('aria-checked')).toBe('true');
    expect(hint(isPublic)).toMatch(/Shown in Space/);
    expect(screen.queryByRole('switch', { name: 'Featured' })).toBeNull();
    unmount();

    render(asSuperAdmin(<NewUniversePage />));
    expect(hint(screen.getByRole('switch', { name: 'Featured' }))).toMatch(/Pinned to the top/);
  });

  it('never send Featured from someone who may not set it, even from an old draft', async () => {
    window.sessionStorage.setItem(
      `${DRAFT_KEY_PREFIX}universe.new`,
      JSON.stringify({ v: FORM_DRAFT_VERSION, name: 'Mine', slug: 'mine', featured: true }),
    );
    route({});
    render(<NewUniversePage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/me'));
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Mine' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(screen.getByRole('button', { name: 'Create universe' }));
    await waitFor(() => expect(posted('/api/admin/universes')).not.toBeNull());
    expect(posted('/api/admin/universes').featured).toBe(false);
  });
});

describe('New room waits for its world', () => {
  it('shows no map or form while your worlds load, nor after they fail', async () => {
    fetchMock.mockImplementation((url: string) =>
      url === '/api/auth/me' ? ok({ user: { id: 'me' } }) : Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
    );
    render(<NewRoomPage />);
    expect(screen.queryByText('Map')).toBeNull();
    expect(await screen.findByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.queryByText('Map')).toBeNull();
    expect(screen.queryByLabelText(/Name/)).toBeNull();
  });

  it('offers a retry when the world in the address cannot be loaded', async () => {
    search = new URLSearchParams('worldId=w1');
    fetchMock.mockImplementation((url: string) =>
      url === '/api/auth/me' ? ok({ user: { id: 'me' } }) : Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
    );
    render(<NewRoomPage />);
    expect(await screen.findByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.queryByLabelText(/Name/)).toBeNull();
  });
});

describe('Creation drafts', () => {
  const WORLD = { id: 'w1', name: 'Office', slug: 'office', universe: { id: 'ua', name: 'Alpha', slug: 'alpha' } };

  it('restore a room’s custom map and a hand-edited address', async () => {
    search = new URLSearchParams('worldId=w1');
    window.sessionStorage.setItem(
      `${DRAFT_KEY_PREFIX}room.new:w1`,
      JSON.stringify({
        v: FORM_DRAFT_VERSION,
        name: 'Lobby',
        slug: 'front-desk',
        description: '',
        mapUrl: 'https://maps.example.com/lobby.tmj',
        isPublic: true,
        addressEdited: true,
        mapMode: 'custom',
        templateMapId: null,
        worldId: '',
      }),
    );
    route({ '/api/admin/worlds/w1': WORLD });
    render(<NewRoomPage />);
    expect(await screen.findByTestId('draft-notice')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Custom map (advanced)' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Use a template' }).getAttribute('aria-pressed')).toBe('false');
    expect((screen.getByLabelText(/Map URL/) as HTMLInputElement).value).toBe('https://maps.example.com/lobby.tmj');
    const slug = screen.getByLabelText(/Address/) as HTMLInputElement;
    expect(slug.value).toBe('front-desk');
    // The address was edited by hand, so a new name leaves it alone.
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Main Lobby' } });
    expect((screen.getByLabelText(/Address/) as HTMLInputElement).value).toBe('front-desk');
    await screen.findByText('/@/alpha/office/front-desk');
  });

  it('restore a room’s template map', async () => {
    const mapId = '11111111-2222-3333-4444-555555555555';
    search = new URLSearchParams('worldId=w1');
    window.sessionStorage.setItem(
      `${DRAFT_KEY_PREFIX}room.new:w1`,
      JSON.stringify({ v: FORM_DRAFT_VERSION, name: 'Lobby', slug: 'lobby', mapMode: 'template', templateMapId: mapId }),
    );
    route({
      '/api/admin/worlds/w1': WORLD,
      [`/api/admin/templates/maps/${mapId}`]: {
        map: { id: mapId, name: 'Small office', mapUrl: 'https://maps.example.com/small.tmj', template: { name: 'Offices' } },
      },
    });
    render(<NewRoomPage />);
    expect(await screen.findByText('Small office')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use a template' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe('Lobby');
    expect(readDraft<{ templateMapId: string }>('room.new:w1')?.templateMapId).toBe(mapId);
  });

  it('remember that a world’s address was edited, and upgrade older drafts safely', async () => {
    search = new URLSearchParams('universeId=ua');
    // A version 1 draft: text only, and an address that isn't the one its name gives.
    window.sessionStorage.setItem(`${DRAFT_KEY_PREFIX}world.new:ua`, JSON.stringify({ name: 'Office', slug: 'hq', description: 'Ours' }));
    route({ '/api/admin/universes': { universes: [UNIVERSE_A] } });
    render(<NewWorldPage />);
    expect(await screen.findByTestId('draft-notice')).toBeTruthy();
    expect((screen.getByLabelText(/Description/) as HTMLTextAreaElement).value).toBe('Ours');
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Office Two' } });
    expect((screen.getByLabelText(/Address/) as HTMLInputElement).value).toBe('hq');
    await waitFor(() => expect(readDraft<{ addressEdited: boolean; v: number }>('world.new:ua')).toMatchObject({ addressEdited: true, v: 2 }));
  });
});

describe('upgradeFormDraft', () => {
  const EMPTY = { v: FORM_DRAFT_VERSION, name: '', slug: '', addressEdited: false, templateMapId: null as string | null };

  it('keeps an address that follows its name following it', () => {
    expect(upgradeFormDraft({ name: 'Head Office', slug: 'head-office' }, EMPTY)).toMatchObject({ addressEdited: false, v: 2 });
  });

  it('drops fields of the wrong type and ignores what is not a draft', () => {
    expect(upgradeFormDraft({ name: 42, slug: 'x', templateMapId: 'abc', extra: true }, EMPTY)).toEqual({
      v: 2,
      name: '',
      slug: 'x',
      addressEdited: true,
      templateMapId: 'abc',
    });
    expect(upgradeFormDraft('nope', EMPTY)).toBeNull();
    expect(upgradeFormDraft([1], EMPTY)).toBeNull();
  });
});
