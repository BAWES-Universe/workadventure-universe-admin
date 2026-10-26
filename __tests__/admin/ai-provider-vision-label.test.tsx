/** @jest-environment jsdom */

import React from 'react';
import { render, screen } from '@testing-library/react';

/** The Universe AI provider page (#575): Vision reads like the model lists (eye and word), Text only when it can't see images. */

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/app/admin/orbit-frame-context', () => ({ useReplacePage: () => jest.fn() }));

import ProviderDetailPage from '@/app/admin/ai-providers/[id]/page';

const base = {
  providerId: 'gemini', name: 'Gemini 3 Flash', type: 'openai', enabled: true, endpoint: null, apiKeyEncrypted: 'x', model: 'gemini-3-flash',
  temperature: null, maxTokens: null, supportsStreaming: true, supportsVision: null, visionModel: null, defaultVision: false, settings: null,
  tested: false, testedAt: null, createdAt: '', updatedAt: '',
};

function open(provider: Record<string, unknown>) {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ...base, ...provider }) });
  render(<ProviderDetailPage params={Promise.resolve({ id: 'gemini' })} />);
}

const visionField = async () => (await screen.findByText('Vision', { selector: 'dt' })).closest('div') as HTMLElement;

beforeEach(() => fetchMock.mockReset());

describe('Universe AI provider page Vision field', () => {
  it('shows the eye and the word Vision, with the note that it was detected', async () => {
    open({});
    const field = await visionField();
    expect(field.textContent).toContain('Vision');
    expect(field.querySelector('svg')).not.toBeNull();
    expect(field.textContent).toContain('auto — detected from model name');
    expect(field.textContent).not.toContain('Vision-capable');
  });

  it('says Text only, without an eye, when the model does not see images', async () => {
    open({ model: 'mythomax', supportsVision: false });
    const field = await visionField();
    expect(field.textContent).toContain('Text only');
    expect(field.textContent).toContain('manually forced');
    expect(field.querySelector('svg')).toBeNull();
  });
});
