'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';

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
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <Card
              key={template.id}
              className="cursor-pointer transition-shadow hover:shadow-md"
              onClick={() => onSelectTemplate(template.slug)}
            >
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    {template.category.icon && (
                      <span className="text-2xl">{template.category.icon}</span>
                    )}
                    <CardTitle className="text-lg">{template.name}</CardTitle>
                  </div>
                  {template.isFeatured && (
                    <Badge variant="secondary" className="text-xs">
                      Featured
                    </Badge>
                  )}
                </div>
                <CardDescription className="mt-2">
                  {template.shortDescription || 'No description available'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>{template.category.name}</span>
                  <span>{template.mapCount} map{template.mapCount !== 1 ? 's' : ''}</span>
                </div>
                <Button className="mt-4 w-full" variant="outline">
                  View Details
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

