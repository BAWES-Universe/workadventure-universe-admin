'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Search, FolderOpen } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface Category {
  id: string;
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  order: number;
}

interface Template {
  id: string;
  slug: string;
  name: string;
  shortDescription?: string;
  philosophy?: string;
  category: {
    id: string;
    slug: string;
    name: string;
    icon?: string;
  };
  mapCount: number;
  isFeatured: boolean;
}

interface TemplateLibraryProps {
  onSelectTemplate: (templateSlug: string) => void;
  selectedCategory?: string;
}

export function TemplateLibrary({ onSelectTemplate, selectedCategory }: TemplateLibraryProps) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>(selectedCategory || 'all');

  useEffect(() => {
    fetchTemplates();
  }, [activeCategory, searchQuery]);

  async function fetchTemplates() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (activeCategory !== 'all') {
        params.append('category', activeCategory);
      }
      if (searchQuery) {
        params.append('search', searchQuery);
      }

      const response = await fetch(`/api/templates?${params.toString()}`);
      if (!response.ok) {
        throw new Error('Failed to fetch templates');
      }

      const data = await response.json();
      setTemplates(data.templates || []);
      setCategories(data.categories || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  }

  if (loading && templates.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search templates..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Category Filter */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={activeCategory === 'all' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setActiveCategory('all')}
        >
          All
        </Button>
        {categories.map((category) => (
          <Button
            key={category.id}
            variant={activeCategory === category.slug ? 'default' : 'outline'}
            size="sm"
            onClick={() => setActiveCategory(category.slug)}
          >
            {category.icon && <span className="mr-1">{category.icon}</span>}
            {category.name}
          </Button>
        ))}
      </div>

      {/* Error State */}
      {error && (
        <div className="rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Templates Grid */}
      {templates.length === 0 && !loading ? (
        <div className="py-12 text-center text-muted-foreground">
          No templates found. Try a different search or category.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {templates.map((template) => (
            <Card
              key={template.id}
              className={cn(
                'group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all cursor-pointer',
                'hover:-translate-y-1 hover:shadow-lg',
              )}
              onClick={() => onSelectTemplate(template.slug)}
            >
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-blue-500/10 via-transparent to-indigo-500/20 opacity-0 transition-opacity group-hover:opacity-100" />

              <div className="relative flex flex-col h-full p-5">
                {template.isFeatured && (
                  <div className="absolute top-4 right-4">
                    <Badge variant="outline" className="text-xs">Featured</Badge>
                  </div>
                )}
                <div className="mb-4 space-y-1 pr-16">
                  <h3 className="truncate text-base font-semibold leading-tight">
                    {template.name}
                  </h3>
                  <div className="flex items-center gap-1.5">
                    {template.category.icon && (
                      <span className="text-sm">{template.category.icon}</span>
                    )}
                    <p className="truncate text-xs text-muted-foreground">
                      {template.category.name}
                    </p>
                  </div>
                </div>

                {template.shortDescription && (
                  <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
                    {template.shortDescription}
                  </p>
                )}
                {template.philosophy && (
                  <div className="mb-3 border-l-2 border-muted-foreground/30 pl-3">
                    <p className="text-xs italic text-white leading-relaxed">
                      &ldquo;{template.philosophy}&rdquo;
                    </p>
                  </div>
                )}

                <div className="mt-auto flex items-center gap-1.5 pt-3 text-xs text-muted-foreground">
                  <FolderOpen className="h-3.5 w-3.5" />
                  <span>
                    {template.mapCount} {template.mapCount === 1 ? 'map' : 'maps'}
                  </span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

