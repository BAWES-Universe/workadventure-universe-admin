/** @jest-environment jsdom */

import { stopTrackingOrbitHistory, trackOrbitHistory } from '@/lib/orbit-history';

const pop = (state: unknown) => window.dispatchEvent(new PopStateEvent('popstate', { state }));

describe("Orbit's steps in the tab's history", () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/admin');
  });
  afterEach(() => stopTrackingOrbitHistory());

  it('counts each page Orbit opens, and marks its step', () => {
    const tracked = trackOrbitHistory();
    expect(tracked.step).toBe(0);
    expect(window.history.state).toEqual({ orbitStep: 0 });
    window.history.pushState({ __NA: true }, '', '/admin/bots');
    window.history.pushState({ __NA: true }, '', '/admin/bots/1');
    expect(tracked.step).toBe(2);
    expect(window.history.state).toEqual({ __NA: true, orbitStep: 2 });
  });

  it('a page in its own place keeps the count, and its mark', () => {
    const tracked = trackOrbitHistory();
    window.history.pushState({ __NA: true }, '', '/admin/bots');
    window.history.replaceState({ __NA: true, tree: 'next' }, '', '/admin/bots?q=sage');
    expect(tracked.step).toBe(1);
    expect(window.history.state).toEqual({ __NA: true, tree: 'next', orbitStep: 1 });
  });

  it('a step replaced before its popstate is heard keeps its own mark', () => {
    const nativeReplace = History.prototype.replaceState;
    trackOrbitHistory();
    window.history.pushState({}, '', '/admin/a');
    window.history.pushState({}, '', '/admin/b');
    // Back has landed on step 1, and something replaces it before Orbit hears the popstate.
    nativeReplace.call(window.history, { __NA: true, orbitStep: 1 }, '');
    window.history.replaceState({ __NA: true, tree: 'next' }, '');
    expect(window.history.state).toEqual({ __NA: true, tree: 'next', orbitStep: 1 });
  });

  it('Back and Forward land on the step they reach', () => {
    const tracked = trackOrbitHistory();
    const heard: number[] = [];
    tracked.subscribe((step) => heard.push(step));
    window.history.pushState({}, '', '/admin/a');
    window.history.pushState({}, '', '/admin/b');
    pop({ __NA: true, orbitStep: 1 });
    pop({ __NA: true, orbitStep: 0 });
    pop({ __NA: true, orbitStep: 2 });
    expect(heard).toEqual([1, 2, 1, 0, 2]);
  });

  it('a step it knows nothing about counts as none, never as more', () => {
    const tracked = trackOrbitHistory();
    window.history.pushState({}, '', '/admin/a');
    pop({ __NA: true });
    expect(tracked.step).toBe(0);
  });

  it('a page loaded again on a marked step starts from that step', () => {
    window.history.replaceState({ __NA: true, orbitStep: 3 }, '', '/admin/a');
    expect(trackOrbitHistory().step).toBe(3);
  });

  it('leaves a state that is not an object as it is', () => {
    trackOrbitHistory();
    window.history.pushState('plain', '', '/admin/a');
    expect(window.history.state).toBe('plain');
  });

  it('starts once per page', () => {
    expect(trackOrbitHistory()).toBe(trackOrbitHistory());
  });
});
