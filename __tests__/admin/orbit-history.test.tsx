/** @jest-environment jsdom */

import { act, renderHook } from '@testing-library/react';
import { useOrbitHistory } from '@/app/admin/hooks/use-orbit-history';

const mockRouter = {
  back: jest.fn(() => window.history.back()),
  replace: jest.fn((url: string) => window.history.replaceState({ __NA: true, tree: url }, '', url)),
};

jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }));

const nativeReplace = window.history.replaceState;

function push(url: string) {
  act(() => window.history.pushState({ __NA: true, tree: url }, '', url));
}

async function traverse(action: () => void) {
  await act(async () => {
    const popped = new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));
    action();
    await popped;
  });
}

describe('useOrbitHistory', () => {
  beforeEach(() => {
    nativeReplace.call(window.history, { __NA: true, tree: 'initial' }, '', '/admin/worlds/deep-link');
    mockRouter.back.mockClear();
    mockRouter.replace.mockClear();
  });

  it('replaces a direct deep link with its parent without leaving the iframe visit', () => {
    const { result } = renderHook(() => useOrbitHistory('/admin/places'));
    act(() => result.current.goBack());
    expect(mockRouter.replace).toHaveBeenCalledWith('/admin/places');
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('never traverses browser history from an unvisited root', () => {
    const { result } = renderHook(() => useOrbitHistory(null));
    act(() => result.current.goBack());
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('backs through actual pushes and recognizes Forward as a restored entry', async () => {
    const { result } = renderHook(() => useOrbitHistory('/admin/places'));
    push('/admin/bots');
    push('/admin/bots/bot-1');

    await traverse(() => result.current.goBack());
    expect(window.location.pathname).toBe('/admin/bots');
    await traverse(() => window.history.forward());
    expect(window.location.pathname).toBe('/admin/bots/bot-1');
    await traverse(() => result.current.goBack());
    expect(window.location.pathname).toBe('/admin/bots');
    await traverse(() => result.current.goBack());
    expect(window.location.pathname).toBe('/admin/worlds/deep-link');

    act(() => result.current.goBack());
    expect(mockRouter.back).toHaveBeenCalledTimes(3);
    expect(mockRouter.replace).toHaveBeenCalledWith('/admin/places');
  });

  it('does not turn router replacements or query replacements into extra Back steps', async () => {
    const { result } = renderHook(() => useOrbitHistory('/admin/places'));
    act(() => mockRouter.replace('/admin/bots'));
    act(() => mockRouter.replace('/admin/bots?view=all'));
    act(() => result.current.goBack());
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/admin/places');

    push('/admin/bots/bot-1');
    act(() => mockRouter.replace('/admin/bots/bot-1?tab=memory'));
    await traverse(() => result.current.goBack());
    expect(window.location.pathname).toBe('/admin/places');
  });

  it('tracks query-only pushes without requiring a pathname render', async () => {
    const { result } = renderHook(() => useOrbitHistory('/admin/places'));
    push('/admin/worlds/deep-link?tab=members');
    await traverse(() => result.current.goBack());
    expect(window.location.search).toBe('');
    act(() => result.current.goBack());
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith('/admin/places');
  });

  it('coalesces rapid Back taps until the first traversal completes', async () => {
    const { result } = renderHook(() => useOrbitHistory('/admin/places'));
    push('/admin/bots');
    await traverse(() => {
      result.current.goBack();
      result.current.goBack();
    });
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/admin/worlds/deep-link');
    act(() => result.current.goBack());
    expect(mockRouter.replace).toHaveBeenCalledWith('/admin/places');
  });

  it('follows the new branch after Back followed by a push', async () => {
    const { result } = renderHook(() => useOrbitHistory('/admin/places'));
    push('/admin/bots');
    push('/admin/bots/old-branch');
    await traverse(() => window.history.back());
    push('/admin/avatars');
    await traverse(() => result.current.goBack());
    expect(window.location.pathname).toBe('/admin/bots');
    await traverse(() => result.current.goBack());
    expect(window.location.pathname).toBe('/admin/worlds/deep-link');
  });

  it('preserves Next router and custom fields without mutating input objects', () => {
    const tree = { tree: ['admin'], renderedSearch: '?view=all' };
    const initial = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: tree, scroll: 7 };
    nativeReplace.call(window.history, initial, '', '/admin');
    renderHook(() => useOrbitHistory(null));
    expect(window.history.state).toMatchObject(initial);

    const pushed = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ['bots'] }, custom: 'keep' };
    act(() => window.history.pushState(pushed, '', '/admin/bots'));
    expect(window.history.state).toMatchObject(pushed);
    expect(pushed).not.toHaveProperty('__universeOrbitHistory');

    const replaced = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ['bots'], renderedSearch: '?all' } };
    act(() => window.history.replaceState(replaced, '', '/admin/bots?all'));
    expect(window.history.state).toMatchObject(replaced);
    expect(replaced).not.toHaveProperty('__universeOrbitHistory');
  });

  it('does not assume an unknown or earlier visit belongs to this visit', () => {
    const first = renderHook(() => useOrbitHistory('/admin/places'));
    push('/admin/bots');
    first.unmount();
    const second = renderHook(() => useOrbitHistory('/admin'));
    act(() => second.result.current.goBack());
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith('/admin');
  });

  it('fails closed if another consumer removes the marker', () => {
    const { result } = renderHook(() => useOrbitHistory('/admin'));
    push('/admin/bots');
    nativeReplace.call(window.history, { __NA: true }, '', '/admin/bots');
    act(() => result.current.goBack());
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith('/admin');
  });

  it('does not link an Orbit entry back through a non-Orbit or sign-in entry', () => {
    const { result } = renderHook(() => useOrbitHistory('/admin'));
    push('/admin/login');
    push('/admin/bots');
    act(() => result.current.goBack());
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith('/admin');
  });

  it('does not trust a copied marker on a different non-Orbit entry', () => {
    const { result } = renderHook(() => useOrbitHistory('/admin'));
    const copied = { ...window.history.state };
    act(() => window.history.pushState(copied, '', '/outside-orbit'));
    push('/admin/bots');
    act(() => result.current.goBack());
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith('/admin');
  });

  it('does not Back into an earlier entry replaced outside Orbit after Forward', async () => {
    const { result } = renderHook(() => useOrbitHistory('/admin'));
    push('/admin/bots');
    await traverse(() => window.history.back());
    act(() => window.history.replaceState({ ...window.history.state }, '', '/outside-orbit'));
    await traverse(() => window.history.forward());
    act(() => result.current.goBack());
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith('/admin');
  });

  it('restores owned wrappers and leaves later consumers intact on unmount', () => {
    const beforePush = window.history.pushState;
    const first = renderHook(() => useOrbitHistory(null));
    first.unmount();
    expect(window.history.pushState).toBe(beforePush);

    const second = renderHook(() => useOrbitHistory(null));
    const orbitPush = window.history.pushState;
    const laterPush: History['pushState'] = function (state, unused, url) {
      orbitPush.call(window.history, state, unused, url);
    };
    window.history.pushState = laterPush;
    second.unmount();
    expect(window.history.pushState).toBe(laterPush);
    window.history.pushState({ custom: 'after-unmount' }, '', '/admin/you');
    expect(window.history.state).toEqual({ custom: 'after-unmount' });
    window.history.pushState = beforePush;
  });
});
