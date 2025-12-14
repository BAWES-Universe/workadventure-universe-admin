'use client';

import { usePathname } from 'next/navigation';
import { ReactNode, Suspense } from 'react';
import TokenHandler from '../token-handler';
import WorkAdventureProvider from '../workadventure-provider';

export default function ConditionalContent({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === '/admin/login';

  if (isLoginPage) {
    return <main>{children}</main>;
  }

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <Suspense fallback={null}>
        <TokenHandler />
      </Suspense>
      <WorkAdventureProvider>
        {children}
      </WorkAdventureProvider>
    </main>
  );
}

