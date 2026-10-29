/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/** The super-admin provider edit page keeps a saved legacy voice type on its list while another type is picked (#704). */

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/app/admin/orbit-frame-context', () => ({ useReplacePage: () => jest.fn(), useOrbitNavigate: () => jest.fn() }));

import EditProviderPage from '@/app/admin/ai-providers/[id]/edit/page';

const legacy = {
  providerId: 'voice', name: 'Voice', type: 'ultravox', enabled: true, endpoint: null, model: 'm', temperature: null, maxTokens: null,
  supportsStreaming: true, supportsVision: null, visionModel: null, defaultVision: false,
};

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.assign(window.HTMLElement.prototype, { hasPointerCapture: () => false, setPointerCapture: () => {}, releasePointerCapture: () => {}, scrollIntoView: () => {} });
});

const optionNames = () => screen.queryAllByRole('option').map((option) => option.textContent);

describe('provider edit page type list', () => {
  it('still offers the saved Ultravox type after another type is picked', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(legacy) });
    render(<EditProviderPage params={Promise.resolve({ id: 'voice' })} />);
    const trigger = await screen.findByLabelText('Type *');
    await waitFor(() => expect(trigger.textContent).toContain('Ultravox'));

    fireEvent.click(trigger);
    expect(optionNames()).toContain('Ultravox');
    fireEvent.click(screen.getByRole('option', { name: 'OpenAI' }));
    await waitFor(() => expect(trigger.textContent).toContain('OpenAI'));

    fireEvent.click(trigger);
    expect(optionNames()).toContain('Ultravox');
  });
});
