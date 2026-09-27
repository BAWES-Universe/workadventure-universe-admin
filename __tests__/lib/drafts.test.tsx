/** @jest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { useDraft } from '@/app/admin/hooks/use-draft';
import { DRAFT_KEY_PREFIX, readDraft } from '@/lib/drafts';

type Form = { name: string; slug: string };
const EMPTY: Form = { name: '', slug: '' };

function useForm(enabled = true) {
  const [value, setValue] = useState<Form>(EMPTY);
  const { discard } = useDraft('test.form', value, setValue, EMPTY, enabled);
  return { value, setValue, discard };
}

describe('drafts survive navigation', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('restores what was typed when the form is mounted again', () => {
    const first = renderHook(() => useForm());
    act(() => first.result.current.setValue({ name: 'Head office', slug: 'head-office' }));
    expect(readDraft<Form>('test.form')).toEqual({ name: 'Head office', slug: 'head-office' });
    first.unmount();

    const second = renderHook(() => useForm());
    expect(second.result.current.value).toEqual({ name: 'Head office', slug: 'head-office' });
  });

  it('keeps nothing for an untouched form', () => {
    const hook = renderHook(() => useForm());
    act(() => hook.result.current.setValue({ ...EMPTY }));
    expect(window.sessionStorage.getItem(`${DRAFT_KEY_PREFIX}test.form`)).toBeNull();
  });

  it('is cleared once the form is submitted', () => {
    const hook = renderHook(() => useForm());
    act(() => hook.result.current.setValue({ name: 'Studio', slug: 'studio' }));
    act(() => hook.result.current.discard());
    expect(readDraft('test.form')).toBeNull();
    hook.unmount();
    const again = renderHook(() => useForm());
    expect(again.result.current.value).toEqual(EMPTY);
  });

  it('waits until the form is ready before restoring', () => {
    window.sessionStorage.setItem(`${DRAFT_KEY_PREFIX}test.form`, JSON.stringify({ name: 'Later', slug: 'later' }));
    const hook = renderHook(({ enabled }) => useForm(enabled), { initialProps: { enabled: false } });
    expect(hook.result.current.value).toEqual(EMPTY);
    hook.rerender({ enabled: true });
    expect(hook.result.current.value).toEqual({ name: 'Later', slug: 'later' });
  });

  it('never restores over a form when the draft is the blank state', () => {
    window.sessionStorage.setItem(`${DRAFT_KEY_PREFIX}test.form`, JSON.stringify(EMPTY));
    const hook = renderHook(() => useForm());
    expect(hook.result.current.value).toEqual(EMPTY);
  });
});
