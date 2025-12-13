'use client';

import { useState, useEffect } from 'react';
import { Sheet, SheetContent, SheetTrigger, SheetClose, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import AuthLink from '../auth-link';
import LogoutButton from '../logout-button';
import { Menu, LayoutDashboard, Globe, Users, UserCircle, LogOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePathname } from 'next/navigation';

interface MobileNavProps {
  user: {
    name: string | null;
    email: string | null;
  } | null;
}

export default function MobileNav({ user: initialUser }: MobileNavProps) {
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState(initialUser);
  const pathname = usePathname();

  // Fetch current user state to ensure it's always up-to-date
  useEffect(() => {
    async function fetchUser() {
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch('/api/auth/me');
        if (response.ok) {
          const data = await response.json();
          if (data.user) {
            setUser({
              name: data.user.name,
              email: data.user.email,
            });
          } else {
            setUser(null);
          }
        } else {
          setUser(null);
        }
      } catch (error) {
        // If fetch fails, keep the initial user or set to null
        setUser(initialUser);
      }
    }

    fetchUser();
  }, [pathname, initialUser]);

  // Close sheet when pathname changes (navigation occurred)
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const navItems = [
    { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/admin/universes', label: 'Universes', icon: Globe },
    { href: '/admin/users', label: 'Users', icon: Users },
    ...(user ? [{ href: '/admin/profile', label: 'Visit Card', icon: UserCircle }] : []),
  ];

  const isActive = (href: string) => {
    if (href === '/admin') {
      return pathname === '/admin';
    }
    return pathname?.startsWith(href);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="sm:hidden relative"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </Button>
      </SheetTrigger>
      <SheetContent 
        side="right" 
        className="w-[320px] sm:w-[400px] p-0 flex flex-col"
      >
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="text-lg font-semibold">Navigation</SheetTitle>
        </SheetHeader>
        
        <ScrollArea className="flex-1">
          <nav className="px-3 py-4 space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.href);
              return (
                <SheetClose key={item.href} asChild>
                  <AuthLink
                    href={item.href}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all",
                      active
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    )}
                  >
                    <Icon className={cn("h-5 w-5", active && "text-primary-foreground")} />
                    {item.label}
                  </AuthLink>
                </SheetClose>
              );
            })}
          </nav>
        </ScrollArea>

        <div className="border-t p-4 space-y-3 mt-auto">
          {user ? (
            <>
              <div className="px-3 py-2 rounded-lg bg-muted/50">
                <p className="text-sm font-semibold text-foreground">
                  {user.name || user.email || 'User'}
                </p>
                {user.email && user.name && (
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">{user.email}</p>
                )}
              </div>
              <div className="px-3">
                <LogoutButton />
              </div>
            </>
          ) : (
            <SheetClose asChild>
              <AuthLink
                href="/admin/login"
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium",
                  "text-primary hover:bg-accent transition-colors w-full"
                )}
              >
                <LogOut className="h-5 w-5" />
                Login
              </AuthLink>
            </SheetClose>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
