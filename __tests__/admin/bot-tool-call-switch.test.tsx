/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BotToolCallSwitch } from '@/components/bot-tool-call-switch';
import { authenticatedFetch } from '@/lib/client-auth';
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: jest.fn() }));

function Page({ initialValue }: { initialValue: boolean }) {
  const [value, setValue] = useState(initialValue);
  return (
    <Tabs defaultValue="overview">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="usage">Usage</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <BotToolCallSwitch botId="bot-a" value={value} onSaved={setValue} />
      </TabsContent>
      <TabsContent value="usage">Usage history</TabsContent>
    </Tabs>
  );
}

beforeEach(() => jest.clearAllMocks());
test('starts off and saves only this bot switch', async () => {
  (authenticatedFetch as jest.Mock).mockResolvedValue({ ok: true });
  render(<Page initialValue={false} />);
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
  render(<Page initialValue={true} />);
  const toggle = screen.getByRole('switch');
  fireEvent.click(toggle);
  await screen.findByRole('alert');
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(toggle).not.toBeDisabled();
});

test('keeps the saved value after Overview unmounts and remounts', async () => {
  (authenticatedFetch as jest.Mock).mockResolvedValue({ ok: true });
  render(<Page initialValue={false} />);
  fireEvent.click(screen.getByRole('switch'));
  await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Usage' }), { button: 0, ctrlKey: false });
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Overview' }), { button: 0, ctrlKey: false });
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  expect(authenticatedFetch).toHaveBeenCalledTimes(1);
});
