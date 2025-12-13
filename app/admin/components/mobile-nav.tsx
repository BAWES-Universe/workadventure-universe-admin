'use client';

import { useState, useEffect } from 'react';
import { Sheet, SheetContent, SheetTrigger, SheetClose, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import AuthLink from '../auth-link';
import LogoutButton from '../logout-button';
import { Menu, LogOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePathname } from 'next/navigation';
import { useUser } from '../hooks/use-user';
import { getNavItems } from '../config/navigation';

interface MobileNavProps {
  user: {
    name: string | null;
    email: string | null;
  } | null;
}

export default function MobileNav({ user: initialUser }: MobileNavProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const { user } = useUser(initialUser ? {
    id: '',
    name: initialUser.name,
    email: initialUser.email,
  } : null);

  // Close sheet when pathname changes (navigation occurred)
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const navItems = getNavItems(user);

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
