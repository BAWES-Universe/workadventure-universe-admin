/** @jest-environment jsdom */

import { RESUME_PATH_KEY, isResumablePath, loginDestination, readResumePath, rememberResumePath } from '@/lib/resume-path';

const LOGIN = 'https://orbit.example.test/admin/login?playUri=https%3A%2F%2Fplay.example.test%2F%40%2Fa%2Fb%2Fc';

describe('the page Orbit comes back to after a reconnect', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('keeps only Orbit pages, never the sign-in page or anything else', () => {
    expect(isResumablePath('/admin')).toBe(true);
    expect(isResumablePath('/admin/bots/abc?tab=access')).toBe(true);
    expect(isResumablePath('/admin/login')).toBe(false);
    expect(isResumablePath('/admin/login?resume=1')).toBe(false);
    expect(isResumablePath('/administrator')).toBe(false);
    expect(isResumablePath('//evil.example/admin')).toBe(false);
    expect(isResumablePath('https://evil.example/admin')).toBe(false);
    expect(isResumablePath('/api/users')).toBe(false);
    expect(isResumablePath(null)).toBe(false);
  });

  it('remembers the latest page and gives it back', () => {
    rememberResumePath('/admin/bots');
    rememberResumePath('/admin/bots/abc?tab=access');
    expect(readResumePath()).toBe('/admin/bots/abc?tab=access');
  });

  it('does not remember a page it would not go back to', () => {
    rememberResumePath('/admin/bots');
    rememberResumePath('/admin/login');
    expect(readResumePath()).toBe('/admin/bots');
  });

  it('ignores a stored value that is not an Orbit page', () => {
    window.sessionStorage.setItem(RESUME_PATH_KEY, 'https://evil.example/admin');
    expect(readResumePath()).toBeNull();
  });

  it('is cleared with the rest of the account state', () => {
    rememberResumePath('/admin/bots');
    window.sessionStorage.clear();
    expect(readResumePath()).toBeNull();
  });
});

describe('where signing in lands', () => {
  it('goes home by default', () => {
    expect(loginDestination(LOGIN, '/admin/bots')).toBe('/admin');
  });

  it('goes to the page Orbit was on when the game asks to resume', () => {
    expect(loginDestination(`${LOGIN}&resume=1`, '/admin/bots/abc?tab=access')).toBe('/admin/bots/abc?tab=access');
  });

  it('goes home when resuming with nothing remembered', () => {
    expect(loginDestination(`${LOGIN}&resume=1`, null)).toBe('/admin');
  });

  it('only resumes on resume=1', () => {
    expect(loginDestination(`${LOGIN}&resume=0`, '/admin/bots')).toBe('/admin');
    expect(loginDestination(`${LOGIN}&resume=yes`, '/admin/bots')).toBe('/admin');
  });

  it('lets an explicit page win over the remembered one', () => {
    expect(loginDestination(`${LOGIN}&resume=1&redirect=%2Fadmin%2Fyou`, '/admin/bots')).toBe('/admin/you');
  });

  it('never leaves Orbit', () => {
    expect(loginDestination(`${LOGIN}&resume=1`, 'https://evil.example/admin')).toBe('/admin');
    expect(loginDestination(`${LOGIN}&resume=1`, '/elsewhere')).toBe('/admin');
  });
});
