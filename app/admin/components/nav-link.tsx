'use client';

import { usePathname } from 'next/navigation';
import AuthLink from '../auth-link';
import { cn } from '@/lib/utils';
import { NAV_ITEMS } from '../config/navigation';

interface NavLinkProps {
  href: string;
  children: React.ReactNode;
  className?: string;
}

export default function NavLink({ href, children, className }: NavLinkProps) {
  const pathname = usePathname();
  
  // More precise matching:
  // - For /admin, only exact match
  // - For other paths, check if there's a more specific nav item that matches
  //   If yes, only match exact. If no, match exact or child path.
  let isActive: boolean;
  
  if (href === '/admin') {
    isActive = pathname === '/admin';
  } else {
    // Check if there's a more specific nav item (longer href) that also matches
    const hasMoreSpecificMatch = NAV_ITEMS.some(
      item => item.href !== href && 
              item.href.startsWith(href + '/') && 
              pathname?.startsWith(item.href)
    );
    
    if (hasMoreSpecificMatch) {
      // Don't match if there's a more specific nav item that matches
      isActive = false;
    } else {
      // Match exact or child path
      isActive = pathname === href || (pathname?.startsWith(href + '/') && pathname !== href);
    }
  }

  return (
    <AuthLink
      href={href}
      className={cn(
        className,
        isActive && "border-foreground text-foreground"
      )}
    >
      {children}
    </AuthLink>
  );
}

