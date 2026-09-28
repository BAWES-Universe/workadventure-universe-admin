/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import QuestProofStudio from '@/app/admin/quests/proof/QuestProofStudio';
import {
  PROOF_STORAGE_KEY,
  availablePaths,
  isQuestProofEnabled,
  newDraft,
  newProofDocument,
  readProofDocument,
} from '@/app/admin/quests/proof/proof-model';

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  jest.restoreAllMocks();
});
const originalFetch = Object.getOwnPropertyDescriptor(global, 'fetch');
afterEach(() => {
  if (originalFetch) Object.defineProperty(global, 'fetch', originalFetch);
  else Reflect.deleteProperty(global, 'fetch');
});

const preview = () => within(screen.getByTestId('player-preview'));
function startExplore() {
  fireEvent.click(screen.getByRole('button', { name: 'Try the welcome' }));
  fireEvent.click(preview().getByRole('button', { name: 'Show me the options' }));
  fireEvent.click(preview().getByRole('button', { name: /Find the Courtyard/ }));
  fireEvent.click(preview().getByRole('button', { name: 'Simulate arriving' }));
}

it('cannot enable the proof in production, or without the explicit development flag', () => {
  expect(isQuestProofEnabled('production', 'true')).toBe(false);
  expect(isQuestProofEnabled('development', undefined)).toBe(false);
  expect(isQuestProofEnabled('development', 'false')).toBe(false);
  expect(isQuestProofEnabled('development', 'true')).toBe(true);
});

it('blocks trying and publishing an Explore path with no target, including through the live preview', () => {
  render(<QuestProofStudio />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Place to explore' }), { target: { value: '' } });
  expect(screen.getByRole('button', { name: 'Try the welcome' })).toBeDisabled();
  expect(preview().getByRole('button', { name: 'Show me the options' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Publish test quest' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: /Explore a place/ }));
  expect(screen.getByRole('button', { name: 'Try the welcome' })).toBeEnabled();
});

it('uses the form target and host in the actual interactive player preview', () => {
  render(<QuestProofStudio />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Place to explore' }), { target: { value: 'studio' } });
  fireEvent.click(screen.getByRole('button', { name: 'An area' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Where does it come from?' }), { target: { value: 'studio' } });
  expect(preview().getByText('Studio corner')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try the welcome' }));
  fireEvent.click(preview().getByRole('button', { name: 'Show me the options' }));
  expect(preview().getByRole('button', { name: /Find the Studio corner/ })).toBeInTheDocument();
  expect(preview().queryByRole('button', { name: /Find the Courtyard/ })).not.toBeInTheDocument();
  fireEvent.click(preview().getByRole('button', { name: /Find the Studio corner/ }));
  expect(preview().getByText(/Step into the Studio corner/)).toBeInTheDocument();
});

it('works with no host, filters guest paths, and restricts Build to the safe practice fixture', () => {
  render(<QuestProofStudio />);
  expect(preview().queryByText('Welcome guide')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: /Make something/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Try the welcome' }));
  fireEvent.click(preview().getByRole('button', { name: 'Show me the options' }));
  expect(preview().queryByRole('button', { name: /Make something/ })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Preview visitor' }), { target: { value: 'editor' } });
  fireEvent.click(preview().getByRole('button', { name: 'Show me the options' }));
  fireEvent.click(preview().getByRole('button', { name: /Make something/ }));
  expect(preview().getByText(/Practice corner.*safe to change/)).toBeInTheDocument();
});

it('declining removes the invitation, and an empty context shows no invitation at all', () => {
  render(<QuestProofStudio />);
  fireEvent.click(preview().getByRole('button', { name: 'Not now' }));
  expect(preview().getByText('At your own pace.')).toBeInTheDocument();
  expect(preview().queryByRole('button', { name: 'Show me the options' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Preview visitor' }), { target: { value: 'empty' } });
  expect(preview().getByText('Just room to explore.')).toBeInTheDocument();
  expect(preview().queryByRole('button', { name: 'Show me the options' })).not.toBeInTheDocument();
});

it('Meet needs both a sent hello and a reply before a test stamp can be earned', () => {
  render(<QuestProofStudio />);
  fireEvent.click(preview().getByRole('button', { name: 'Show me the options' }));
  fireEvent.click(preview().getByRole('button', { name: /Meet someone/ }));
  fireEvent.click(preview().getByRole('button', { name: 'Simulate a hello' }));
  expect(preview().getByText('Waiting for a reply')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Publish test quest' })).not.toBeInTheDocument();
  fireEvent.click(preview().getByRole('button', { name: 'Simulate a reply' }));
  expect(preview().getByText('Test complete. Nothing was granted.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Publish test quest' })).toBeInTheDocument();
});

it('publishes and pauses only the test document, keeping test progress when edited', () => {
  const fetchSpy = jest.fn().mockRejectedValue(new Error('The proof must make no network calls'));
  Object.defineProperty(global, 'fetch', { value: fetchSpy, configurable: true, writable: true });
  render(<QuestProofStudio />);
  startExplore();
  fireEvent.click(screen.getByRole('button', { name: 'Publish test quest' }));
  expect(screen.getByText('Published in this test')).toBeInTheDocument();
  expect(screen.getByText('1 test path completed')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Pause test quest' }));
  expect(screen.getByText('Paused in this test')).toBeInTheDocument();
  expect(screen.getByText('1 test path completed')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Edit welcome' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Meet someone/ }));
  const stored = readProofDocument(sessionStorage.getItem(PROOF_STORAGE_KEY));
  expect(stored?.completedTests).toEqual(['explore']);
  expect(stored?.published?.draft.paths.meet).toBe(true);
  expect(stored?.draft.paths.meet).toBe(false);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('tests the published snapshot after reload, while preserving an unpublished edit', () => {
  const document = newProofDocument();
  document.published = { draft: { ...newDraft(), name: 'Published welcome' }, status: 'published' };
  document.draft.name = 'Unpublished revision';
  document.completedTests = ['explore'];
  sessionStorage.setItem(PROOF_STORAGE_KEY, JSON.stringify(document));
  render(<QuestProofStudio />);
  expect(screen.getByRole('heading', { name: 'Published welcome' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try it again' }));
  expect(preview().getByRole('heading', { name: 'Published welcome' })).toBeInTheDocument();
  expect(preview().queryByText('Unpublished revision')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(screen.getByLabelText('Welcome name')).toHaveValue('Unpublished revision');
});

it('mirrors a readable Arabic preview and preserves the same target selection', () => {
  render(<QuestProofStudio />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview in Arabic' }));
  expect(screen.getByTestId('player-preview')).toHaveAttribute('dir', 'rtl');
  fireEvent.click(preview().getByRole('button', { name: 'أرني الخيارات' }));
  expect(preview().getByRole('button', { name: /اكتشف الفناء/ })).toBeInTheDocument();
});

it('survives corrupt or unavailable storage without using real account preferences', () => {
  expect(readProofDocument('{invalid')).toBeNull();
  expect(readProofDocument(JSON.stringify({ schema: 1, draft: {}, published: null, completedTests: [] }))).toBeNull();
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('Blocked');
  });
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Blocked');
  });
  render(<QuestProofStudio />);
  expect(screen.getByText('Storage unavailable. Keep this view open.')).toBeInTheDocument();
  startExplore();
  expect(preview().getByText('Test complete. Nothing was granted.')).toBeInTheDocument();
});

it('never offers a social path when nobody is available', () => {
  expect(availablePaths(newDraft(), 'alone')).toEqual(['explore']);
  expect(availablePaths(newDraft(), 'empty')).toEqual([]);
});
