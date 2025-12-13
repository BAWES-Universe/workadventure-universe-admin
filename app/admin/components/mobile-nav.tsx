'use client';

import { useState } from 'react';
import { Sheet, SheetContent, SheetTrigger, SheetClose } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import AuthLink from '../auth-link';
import LogoutButton from '../logout-button';
import { Menu } from 'lucide-react';

interface MobileNavProps {
  user: {
    name: string | null;
    email: string | null;
  } | null;
}

export default function MobileNav({ user }: MobileNavProps) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="sm:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-6 w-6" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-[300px] sm:w-[400px]">
        <div className="flex flex-col h-full">
          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-4">Navigation</h2>
            <nav className="flex flex-col space-y-2">
              <SheetClose asChild>
                <AuthLink
                  href="/admin"
                  className="text-left px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-gray-900"
                >
                  Dashboard
                </AuthLink>
              </SheetClose>
              <SheetClose asChild>
                <AuthLink
                  href="/admin/universes"
                  className="text-left px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-gray-900"
                >
                  Universes
                </AuthLink>
              </SheetClose>
              <SheetClose asChild>
                <AuthLink
                  href="/admin/users"
                  className="text-left px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-gray-900"
                >
                  Users
                </AuthLink>
              </SheetClose>
              {user && (
                <SheetClose asChild>
                  <AuthLink
                    href="/admin/profile"
                    className="text-left px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-gray-900"
                  >
                    Visit Card
                  </AuthLink>
                </SheetClose>
              )}
            </nav>
          </div>
          <div className="mt-auto pt-6 border-t">
            {user ? (
              <div className="space-y-4">
                <div className="px-3">
                  <p className="text-sm font-medium text-gray-900">
                    {user.name || user.email || 'User'}
                  </p>
                </div>
                <LogoutButton />
              </div>
            ) : (
              <SheetClose asChild>
                <AuthLink
                  href="/admin/login"
                  className="block text-left px-3 py-2 rounded-md text-sm font-medium text-indigo-600 hover:text-indigo-900"
                >
                  Login
                </AuthLink>
              </SheetClose>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

