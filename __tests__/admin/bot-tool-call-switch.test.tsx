/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BotToolCallSwitch } from '@/components/bot-tool-call-switch';
import { authenticatedFetch } from '@/lib/client-auth';
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: jest.fn() }));

beforeEach(() => jest.clearAllMocks());
test('starts off and saves only this bot switch', async () => {
  (authenticatedFetch as jest.Mock).mockResolvedValue({ ok: true });
  render(<BotToolCallSwitch botId="bot-a" initialValue={false} />);
  const toggle = screen.getByRole('switch', { name: 'Show tool calls' });
  expect(toggle).toHaveAttribute('aria-checked', 'false');
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  expect(authenticatedFetch).toHaveBeenCalledWith(
    '/api/admin/bots/bot-a',
    expect.objectContaining({ method: 'PATCH', body: '{"showToolCalls":true}' })
  );
});
test('keeps the previous setting and shows a retryable error when save fails', async () => {
  (authenticatedFetch as jest.Mock).mockResolvedValue({ ok: false });
  render(<BotToolCallSwitch botId="bot-a" initialValue={true} />);
  const toggle = screen.getByRole('switch');
  fireEvent.click(toggle);
  await screen.findByRole('alert');
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(toggle).not.toBeDisabled();
});
