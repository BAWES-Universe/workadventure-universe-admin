'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, Loader2, Shield, Plus, FolderOpen } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Category {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  order: number;
  isActive: boolean;
  _count: {
    templates: number;
    maps: number;
  };
}

export default function TemplatesAdminPage() {
  const router = useRouter();
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }

      const data = await response.json();
      setIsSuperAdmin(data.user?.isSuperAdmin || false);
      fetchCategories();
    } catch (err) {
      router.push('/admin/login');
    } finally {
      setCheckingAuth(false);
    }
  }

  async function fetchCategories() {
    try {
      setLoading(true);
      // Use public API endpoint for all users
      const response = await fetch('/api/templates/categories');
      
      if (!response.ok) {
        throw new Error('Failed to fetch categories');
      }

      const data = await response.json();
      setCategories(data.categories || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load categories');
    } finally {
      setLoading(false);
    }
  }

  if (checkingAuth) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <div className="space-y-2">
          <h1 className="text-4xl font-bold tracking-tight mb-[20px]">Room Templates</h1>
          <p className="text-muted-foreground text-base mb-[30px]">
            Browse our directory of room templates and maps to use when creating rooms. Each template includes multiple map variants to choose from.
          </p>
        </div>
        
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold">Categories</h2>
          {isSuperAdmin && (
            <Button asChild>
              <Link href="/admin/templates/categories/new">
                <Plus className="h-4 w-4 mr-2" />
                Create Category
              </Link>
            </Button>
          )}
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading ? (
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      ) : categories.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No categories yet</CardTitle>
            <CardDescription>
              {isSuperAdmin 
                ? 'Create your first category to start organizing templates.'
                : 'No template categories are available yet.'}
            </CardDescription>
          </CardHeader>
          {isSuperAdmin && (
            <CardContent>
              <Button asChild>
                <Link href="/admin/templates/categories/new">
                  <Plus className="mr-2 h-4 w-4" />
                  Create your first category
                </Link>
              </Button>
            </CardContent>
          )}
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {categories.map((category) => (
            <Link
              key={category.id}
              href={`/admin/templates/categories/${category.id}`}
              className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Card
                className={cn(
                  'group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
                  'hover:-translate-y-1 hover:shadow-lg',
                )}
              >
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-blue-500/10 via-transparent to-indigo-500/20 opacity-0 transition-opacity group-hover:opacity-100" />

                <div className="relative flex flex-col h-full p-5">
                  {isSuperAdmin && (
                    <div className="absolute bottom-4 right-4 z-10">
                      <Badge variant={category.isActive ? 'default' : 'secondary'}>
                        {category.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </div>
                  )}
                  <div className="mb-4 flex items-start gap-3">
                    <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg border-border/70 border bg-muted text-xl">
                      {category.icon || <FolderOpen className="h-6 w-6 text-muted-foreground" />}
                    </div>

                    <div className="min-w-0 flex-1 space-y-1">
                      <h3 className="truncate text-base font-semibold leading-tight">
                        {category.name}
                      </h3>
                      {category.description && (
                        <p className="line-clamp-2 text-sm text-muted-foreground">
                          {category.description}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="mt-auto flex items-center gap-3 pt-3 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                      <FolderOpen className="h-3.5 w-3.5" />
                      <span>
                        {category._count.templates} {category._count.templates === 1 ? 'template' : 'templates'}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <FolderOpen className="h-3.5 w-3.5" />
                      <span>
                        {category._count.maps} {category._count.maps === 1 ? 'map' : 'maps'}
                      </span>
                    </div>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
