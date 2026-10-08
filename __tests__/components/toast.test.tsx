/** @jest-environment jsdom */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider, useToast, type Toast } from '@/components/ui/toast';

function Show({ toast }: { toast: Omit<Toast, 'id'> }) {
  const { addToast } = useToast();
  return <button onClick={() => addToast(toast)}>show</button>;
}

function showToast(toast: Omit<Toast, 'id'>) {
  render(
    <ToastProvider>
      <Show toast={toast} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByText('show'));
}

describe('Toast', () => {
  it('draws a success on the ink surface as a status, without the old green box', () => {
    showToast({ description: 'Invitation sent successfully!', variant: 'success' });
    const toast = screen.getByRole('status');
    expect(toast.textContent).toContain('Invitation sent successfully!');
    expect(toast.className).toContain('orbit-toast');
    expect(toast.className).not.toContain('orbit-toast-error');
    expect(toast.className).not.toMatch(/green|bg-background/);
  });

  it('draws an error with the coral edge and announces it as an alert', () => {
    showToast({ description: 'Failed to send invitation', variant: 'error' });
    const toast = screen.getByRole('alert');
    expect(toast.className).toContain('orbit-toast-error');
    expect(toast.className).not.toMatch(/red-/);
  });

  it('closes with the close button and on its own after its duration', () => {
    jest.useFakeTimers();
    try {
      showToast({ description: 'First', duration: 5000 });
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('status')).toBeNull();

      fireEvent.click(screen.getByText('show'));
      expect(screen.getByRole('status')).toBeTruthy();
      act(() => {
        jest.advanceTimersByTime(5000);
      });
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
