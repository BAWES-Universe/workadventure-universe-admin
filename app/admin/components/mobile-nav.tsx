'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import AuthLink from '../auth-link';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePathname } from 'next/navigation';
import { useUser } from '../hooks/use-user';
import { getNavItems } from '../config/navigation';
import { createPortal } from 'react-dom';

interface MobileNavProps {
  user: {
    name: string | null;
    email: string | null;
  } | null;
}

export default function MobileNav({ user: initialUser }: MobileNavProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pressed, setPressed] = useState(false);
  const pathname = usePathname();
  const { user } = useUser(initialUser ? {
    id: '',
    name: initialUser.name,
    email: initialUser.email,
  } : null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Close menu when pathname changes (navigation occurred)
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Prevent body scroll when menu is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  const navItems = getNavItems(user);

  const isActive = (href: string) => {
    if (href === '/admin') {
      return pathname === '/admin';
    }
    return pathname?.startsWith(href);
  };

  const menuContent = open && mounted && createPortal(
    <div 
      className={cn(
        "fixed inset-0 top-16 bg-background/80 backdrop-blur-md z-[100]",
        "animate-in fade-in-0 duration-200"
      )}
      onClick={() => setOpen(false)}
    >
      <div className="h-full overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.href);
              return (
                <AuthLink
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className={cn(
                    "flex items-center gap-4 px-4 py-4 rounded-lg text-2xl font-bold transition-all",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "text-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <Icon className={cn("h-7 w-7", active && "text-primary-foreground")} />
                  {item.label}
                </AuthLink>
              );
            })}
          </nav>
          
          {user && (
            <div className="mt-8 pt-8 border-t">
              <div className="px-4 py-3 rounded-lg bg-muted/50">
                <p className="text-lg font-semibold text-foreground">
                  {user.name || user.email || 'User'}
                </p>
                {user.email && user.name && (
                  <p className="text-sm text-muted-foreground mt-1 truncate">{user.email}</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );

  return (
    <>
      <button
        className={cn(
          "gap-2 px-3 h-auto -ml-3 transition-colors inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 hover:bg-accent hover:text-accent-foreground",
          open && "bg-accent text-accent-foreground"
        )}
        aria-label="Toggle menu"
        onClick={() => setOpen(!open)}
        onMouseDown={() => setPressed(true)}
        onMouseUp={() => setPressed(false)}
        onMouseLeave={() => setPressed(false)}
      >
        <div className="flex flex-col gap-1.5 w-4 relative">
          <span 
            className={cn(
              "h-0.5 w-full bg-current transition-all duration-300 origin-center",
              open ? "rotate-45 translate-y-[6px]" : "rotate-0 translate-y-0"
            )}
            style={{ color: pressed ? 'hsl(var(--muted-foreground))' : 'currentColor' }}
          />
          <span 
            className={cn(
              "h-0.5 w-full bg-current transition-all duration-300 origin-center",
              open ? "-rotate-45 -translate-y-[6px]" : "rotate-0 translate-y-0"
            )}
            style={{ color: pressed ? 'hsl(var(--muted-foreground))' : 'currentColor' }}
          />
        </div>
        <span 
          className="font-medium text-lg transition-colors"
          style={{ color: pressed ? 'hsl(var(--muted-foreground))' : 'currentColor' }}
        >
          Orbit Menu
        </span>
      </button>
      {menuContent}
    </>
  );
}
