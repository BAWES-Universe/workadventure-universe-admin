/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BotPrivacyCard } from '@/components/bot-privacy-card';
import { BotConversationsPrivate, BotMemoryPrivate } from '@/components/bot-private-notice';
import { authenticatedFetch } from '@/lib/client-auth';

jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: jest.fn() }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const fetchMock = authenticatedFetch as jest.Mock;
const ok = (body: unknown = {}) => ({ ok: true, json: async () => body });

beforeEach(() => fetchMock.mockReset().mockResolvedValue(ok()));

describe('the per-bot setting card', () => {
  const privacy = { universeHides: false, choice: 'follow' as const, hidden: false };

  it('says what it does and what it does not promise, in plain words', () => {
    render(<BotPrivacyCard botId="bot-1" privacy={privacy} onChanged={jest.fn()} />);
    expect(screen.getByText('Hide bot conversations')).toBeTruthy();
    expect(screen.getByText(/Messages are still stored and still sent to the AI provider you chose/)).toBeTruthy();
  });

  it('offers Follow universe, Private and Normal, with the picked one checked, and saves a pick', async () => {
    const onChanged = jest.fn();
    render(<BotPrivacyCard botId="bot-1" privacy={privacy} onChanged={onChanged} />);
    expect(screen.getByRole('radio', { name: 'Follow universe' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Private' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/bots/bot-1/privacy', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ choice: 'private' }) }));
  });

  it('does not offer Normal in a universe that hides bot conversations, and says why', () => {
    render(<BotPrivacyCard botId="bot-1" privacy={{ universeHides: true, choice: 'follow', hidden: true }} onChanged={jest.fn()} />);
    expect((screen.getByRole('radio', { name: 'Normal' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/This universe hides bot conversations/)).toBeTruthy();
  });

  it('says so when saving fails, and does not report a change', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'Nope.' }) });
    const onChanged = jest.fn();
    render(<BotPrivacyCard botId="bot-1" privacy={privacy} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Private' }));
    expect(await screen.findByText('Nope.')).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('a bot that hides its conversations', () => {
  it('shows a notice and the count in place of the conversations, and offers deleting old transcripts', () => {
    render(<BotConversationsPrivate replies={12} />);
    expect(screen.getByText('Private')).toBeTruthy();
    expect(screen.getByText(/12 AI calls so far/)).toBeTruthy();
    expect(screen.getByText(/stay hidden until they are deleted/)).toBeTruthy();
  });

  it('shows how many people it remembers and nothing it remembers, with Forget for each and for everyone', () => {
    render(<BotMemoryPrivate botId="bot-1" onForgotten={jest.fn()} details={{ people: 2, lastUpdated: 1_700_000_000_000, replies: 5, remembered: [{ id: 1, name: 'Bob', isGuest: false, updatedAt: 1 }, { id: 2, name: null, isGuest: true, updatedAt: 2 }] }} />);
    expect(screen.getByText(/Remembers 2 people, last updated/)).toBeTruthy();
    expect(screen.getByText('Bob')).toBeTruthy();
    expect(screen.getByText('A guest')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Forget everyone' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Forget' })).toHaveLength(2);
  });

  it('asks before it forgets, then asks Orbit to forget that one person', async () => {
    const onForgotten = jest.fn();
    render(<BotMemoryPrivate botId="bot-1" onForgotten={onForgotten} details={{ people: 1, lastUpdated: 1, replies: 0, remembered: [{ id: 7, name: 'Bob', isGuest: false, updatedAt: 1 }] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText('Forget Bob?')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Forget' }).pop() as HTMLElement);
    await waitFor(() => expect(onForgotten).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/bots/bot-1/forget', expect.objectContaining({ method: 'POST', body: JSON.stringify({ memoryId: 7 }) }));
    expect(await screen.findByText(/Forgotten\. The bot drops Bob/)).toBeTruthy();
  });

  it('says so when forgetting fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'Forget is for bots that hide their conversations.' }) });
    render(<BotMemoryPrivate botId="bot-1" onForgotten={jest.fn()} details={{ people: 1, lastUpdated: 1, replies: 0, remembered: [] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Forget everyone' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Forget' }).pop() as HTMLElement);
    expect(await screen.findByText('Forget is for bots that hide their conversations.')).toBeTruthy();
  });
});
