/** @jest-environment jsdom */

import React from 'react';
import { render, screen } from '@testing-library/react';

/**
 * The profile opens as a form only when someone asked to edit it (the game's "Edit my profile"), and the address drops
 * that ask at once, so Back, a reload or a later visit shows the profile.
 */

let search = '';
const replace = jest.fn();
jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ replace }),
}));
const cardProps: Array<{ startEditing?: boolean }> = [];
jest.mock('@/app/admin/components/profile-card', () => ({
  ProfileCard: (props: { startEditing?: boolean }) => {
    cardProps.push(props);
    return null;
  },
}));
jest.mock('@/app/admin/components/yours', () => ({ __esModule: true, default: () => null }));
jest.mock('@/app/admin/components/quests/you-quests', () => ({
  YouQuests: () => <div data-testid="you-quests" />,
  YouBadges: () => <div data-testid="you-badges" />,
}));
jest.mock('@/app/admin/admin-bootstrap-context', () => ({ useAdminBootstrap: () => ({ user: { id: 'u', uuid: 'u', name: 'Me', email: null, tags: [], isSuperAdmin: false }, mine: null }) }));

import YouPage from '@/app/admin/you/page';

beforeEach(() => {
  replace.mockReset();
  cardProps.length = 0;
});

describe('You and the edit intent', () => {
  it('shows the profile, not the form, when nobody asked to edit', () => {
    search = '';
    render(<YouPage />);
    expect(cardProps[0].startEditing).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });

  it('opens the form when asked, and drops the ask from the address straight away', () => {
    search = 'edit=profile';
    render(<YouPage />);
    expect(cardProps[0].startEditing).toBe(true);
    expect(replace).toHaveBeenCalledWith('/admin/you', { scroll: false });
  });

  it('puts your quests and, apart, your badges right under the profile, and no settings: they are in the Orbit Menu', () => {
    search = '';
    render(<YouPage />);
    expect(screen.getByTestId('you-quests')).toBeTruthy();
    expect(screen.getByTestId('you-badges')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Sign out/ })).toBeNull();
  });
});
