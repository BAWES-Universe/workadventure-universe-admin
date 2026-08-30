'use client';

import Link from 'next/link';
import type { ComponentProps } from 'react';

/** Legacy wrapper kept to avoid touching every navigation component. */
export default function AuthLink(props: ComponentProps<typeof Link>) {
  return <Link {...props} />;
}
