'use client';

import { usePathname } from 'next/navigation';
import AuthLink from '../auth-link';
import { cn } from '@/lib/utils';

interface NavLinkProps {
  href: string;
  children: React.ReactNode;
  className?: string;
}

export default function NavLink({ href, children, className }: NavLinkProps) {
  const pathname = usePathname();
  const isActive = href === '/admin' ? pathname === '/admin' : pathname?.startsWith(href);

  return (
    <AuthLink
      href={href}
      className={cn(
        className,
        isActive && "border-gray-900 text-gray-900"
      )}
    >
      {children}
    </AuthLink>
  );
}

