/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/** The Universe AI page (#374): the super admin's provider list, one row marked Default, Make default with a confirm. */

const fetchMock = jest.fn();
const replacePage = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
jest.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: jest.fn() }) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/app/admin/orbit-frame-context', () => ({ useReplacePage: () => replacePage }));

import AiProvidersPage from '@/app/admin/ai-providers/page';

const base = { endpoint: null, tested: false, testedAt: null, createdAt: '', updatedAt: '', pinnedBots: 0, universeAiBots: 0 };
const deepseek = { ...base, providerId: 'deepseek', name: 'DeepSeek V4 Flash', type: 'openai', model: 'deepseek-v4-flash', enabled: true, isDefault: true, pinnedBots: 2, universeAiBots: 29, endpoint: 'https://api.deepseek.com' };
const lmstudio = { ...base, providerId: 'lmstudio', name: 'LM Studio Local', type: 'lmstudio', model: 'qwen3-8b', enabled: true, isDefault: false, pinnedBots: 2 };
const vision = { ...base, providerId: 'vision', name: 'OpenAI vision', type: 'openai', model: 'gpt-5-mini', enabled: false, isDefault: false, defaultVision: true };

function answer(providers: unknown[], patch: { ok: boolean; body?: unknown } = { ok: true, body: {} }) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/auth/me') return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: { isSuperAdmin: true } }) });
    if (init?.method === 'PATCH') return Promise.resolve({ ok: patch.ok, status: patch.ok ? 200 : 400, json: () => Promise.resolve(patch.body) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(providers) });
  });
}

const row = (name: string) => screen.getByText(name).closest('[data-kind="provider"]') as HTMLElement;

beforeEach(() => {
  fetchMock.mockReset();
  replacePage.mockReset();
});

describe('Universe AI page', () => {
  it('is called Universe AI and says what it is', async () => {
    answer([deepseek]);
    render(<AiProvidersPage />);
    expect(await screen.findByRole('heading', { name: 'Universe AI' })).toBeTruthy();
    expect(screen.getByText(/People see one choice, Universe AI: it uses the default below/)).toBeTruthy();
  });

  it('marks the Default, which can’t be turned off, and counts its bots', async () => {
    answer([deepseek, lmstudio, vision]);
    render(<AiProvidersPage />);
    await screen.findByText('DeepSeek V4 Flash');
    const first = row('DeepSeek V4 Flash');
    expect(within(first).getByText('Default')).toBeTruthy();
    expect(within(first).getByText(/31 bots/)).toBeTruthy();
    expect(within(first).queryByRole('button')).toBeNull();
  });

  it('gives the others Make default and Disable, and a disabled one only Enable', async () => {
    answer([deepseek, lmstudio, vision]);
    render(<AiProvidersPage />);
    await screen.findByText('LM Studio Local');
    const second = row('LM Studio Local');
    expect(within(second).getByRole('button', { name: 'Make LM Studio Local the default' })).toBeTruthy();
    expect(within(second).getByRole('button', { name: 'Disable LM Studio Local' })).toBeTruthy();
    expect(within(second).getByText(/2 bots pinned/)).toBeTruthy();
    const third = row('OpenAI vision');
    expect(within(third).queryByRole('button', { name: /default/i })).toBeNull();
    expect(within(third).getByRole('button', { name: 'Enable OpenAI vision' })).toBeTruthy();
    expect(within(third).getByText(/Describes images/)).toBeTruthy();
  });

  it('asks before changing the Default, says who moves, and sends only isDefault', async () => {
    answer([deepseek, lmstudio]);
    render(<AiProvidersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make LM Studio Local the default' }));
    expect(await screen.findByText('Make LM Studio Local the default?')).toBeTruthy();
    expect(screen.getByText(/The 29 bots on Universe AI switch to it on their next reply/)).toBeTruthy();
    expect(screen.getByText(/The 4 bots pinned to a provider keep theirs/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Make default' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
    const [url, init] = fetchMock.mock.calls.find(([, call]) => call?.method === 'PATCH')!;
    expect(url).toBe('/api/admin/ai-providers/lmstudio');
    expect(JSON.parse(init.body)).toEqual({ isDefault: true });
  });

  it('cancelling changes nothing', async () => {
    answer([deepseek, lmstudio]);
    render(<AiProvidersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make LM Studio Local the default' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('shows the server’s reason when it says no, and keeps the sheet open', async () => {
    answer([deepseek, lmstudio], { ok: false, body: { error: 'Enable this provider before making it the default.' } });
    render(<AiProvidersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make LM Studio Local the default' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Make default' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Enable this provider/);
    expect(screen.getByText('Make LM Studio Local the default?')).toBeTruthy();
  });
});
