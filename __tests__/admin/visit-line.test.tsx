/** @jest-environment jsdom */

import React from 'react';
import { render } from '@testing-library/react';
import { VisitLine } from '@/app/admin/components/ds';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

describe('VisitLine', () => {
  it('says you haven’t visited, never "last visited by you never"', () => {
    const { container } = render(<VisitLine you={null} latest={minutesAgo(5)} />);
    expect(container.textContent).toContain('You haven’t visited yet');
    expect(container.textContent).not.toMatch(/never/);
    expect(container.textContent).toMatch(/Most recent visitor\s*5 minutes ago/);
  });

  it('shows when you were last there, and nothing when nobody has been', () => {
    expect(render(<VisitLine you={minutesAgo(12)} latest={minutesAgo(3)} />).container.textContent).toMatch(/Last visited by you\s*12 minutes ago/);
    expect(render(<VisitLine you={null} latest={null} />).container.textContent).toBe('');
  });
});
