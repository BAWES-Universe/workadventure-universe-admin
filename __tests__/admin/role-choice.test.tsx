/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { RoleChoice } from '@/app/admin/components/role-choice';

function Roles() {
  const [role, setRole] = useState('member');
  return <RoleChoice value={role} onChange={setRole} />;
}

it('offers one tab stop and keyboard selection with wrapping and Home/End', () => {
  render(<Roles />);
  const [admin, editor, member] = screen.getAllByRole('radio');
  expect([admin.tabIndex, editor.tabIndex, member.tabIndex]).toEqual([-1, -1, 0]);
  member.focus();
  fireEvent.keyDown(member, { key: 'ArrowDown' });
  expect(admin).toHaveFocus();
  expect(admin).toHaveAttribute('aria-checked', 'true');
  expect([admin.tabIndex, editor.tabIndex, member.tabIndex]).toEqual([0, -1, -1]);
  fireEvent.keyDown(admin, { key: 'ArrowRight' });
  expect(editor).toHaveFocus();
  expect(editor).toHaveAttribute('aria-checked', 'true');
  fireEvent.keyDown(editor, { key: 'End' });
  expect(member).toHaveFocus();
  fireEvent.keyDown(member, { key: 'Home' });
  expect(admin).toHaveFocus();
  fireEvent.keyDown(admin, { key: 'ArrowUp' });
  expect(member).toHaveFocus();
});
