'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Loader2, Plus } from 'lucide-react';
import { EmptyCard, EntityCard, LoadError, LoadingRows, PageHeader, SectionHeader, StatLine, count } from '../components/ds';
import { InactivePill } from './components/template-bits';

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    } catch {
      router.push('/admin/login');
    } finally {
      setCheckingAuth(false);
    }
  }

  async function fetchCategories() {
    try {
      setLoading(true);
      setError(null);
      // Use public API endpoint for all users
      const response = await fetch('/api/templates/categories');
      
      if (!response.ok) {
        throw new Error('Failed to fetch categories');
      }

      const data = await response.json();
      setCategories(data.categories || []);
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
      <PageHeader
        kind="template"
        title="Room templates"
        context={<span className="text-sm text-muted-foreground">Ready-made rooms and maps to start a room from. Each template has one or more maps to choose from.</span>}
        actions={
          isSuperAdmin ? (
            <Button asChild className="h-11">
              <Link href="/admin/templates/categories/new">
                <Plus className="mr-2 h-4 w-4" />
                New category
              </Link>
            </Button>
          ) : undefined
        }
      />

      <section aria-labelledby="template-categories">
        <SectionHeader id="template-categories" title="Categories" count={loading || error ? undefined : categories.length} />
        {loading ? (
          <LoadingRows label="categories" rows={3} />
        ) : error ? (
          <LoadError label="categories" retry={fetchCategories} />
        ) : categories.length === 0 ? (
          <EmptyCard
            kind="category"
            title="No categories yet"
            text={isSuperAdmin ? 'Create the first category to start organising templates.' : 'No template categories are available yet.'}
            href={isSuperAdmin ? '/admin/templates/categories/new' : undefined}
            action={isSuperAdmin ? 'Create a category' : undefined}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {categories.map((category) => (
              <EntityCard
                key={category.id}
                href={`/admin/templates/categories/${category.id}`}
                kind="category"
                title={category.icon ? `${category.icon} ${category.name}` : category.name}
                description={category.description}
                aside={isSuperAdmin && !category.isActive ? <InactivePill /> : undefined}
                meta={<StatLine items={[count(category._count.templates, 'template'), count(category._count.maps, 'map')]} />}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
