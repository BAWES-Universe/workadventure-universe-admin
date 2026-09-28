'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { KindIcon, LoadError, LoadingRows, StatLine, StatusPill, count } from '@/app/admin/components/ds';

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

  if (loading && templates.length === 0 && !error) {
    return <LoadingRows label="templates" rows={3} />;
  }

  return (
    <div className="space-y-6">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          placeholder="Search templates..."
          aria-label="Search templates"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-11 pl-9"
        />
      </div>

      {/* Category Filter */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Categories">
        <Button
          type="button"
          variant={activeCategory === 'all' ? 'secondary' : 'outline'}
          aria-pressed={activeCategory === 'all'}
          className="h-11 rounded-full"
          onClick={() => setActiveCategory('all')}
        >
          All
        </Button>
        {categories.map((category) => (
          <Button
            key={category.id}
            type="button"
            variant={activeCategory === category.slug ? 'secondary' : 'outline'}
            aria-pressed={activeCategory === category.slug}
            className="h-11 rounded-full"
            onClick={() => setActiveCategory(category.slug)}
          >
            {category.icon && <span className="mr-1">{category.icon}</span>}
            {category.name}
          </Button>
        ))}
      </div>

      {/* Templates Grid */}
      {error ? (
        <LoadError label="templates" retry={fetchTemplates} />
      ) : templates.length === 0 && !loading ? (
        <p className="py-6 text-sm text-muted-foreground">
          No templates found. Try a different search or category.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {templates.map((template) => (
            <article
              key={template.id}
              className="group relative grid min-w-0 gap-3 rounded-[18px] border bg-card p-4 transition-[border-color,transform] hover:-translate-y-px hover:border-foreground/20 motion-reduce:transform-none"
            >
              <div className="flex items-start gap-3">
                <KindIcon kind="template" />
                <div className="grid min-w-0 flex-1 gap-1">
                  <h3 className="text-base font-bold leading-snug [overflow-wrap:anywhere]">
                    <button
                      type="button"
                      onClick={() => onSelectTemplate(template.slug)}
                      className="text-left outline-none after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring"
                    >
                      {template.name}
                    </button>
                  </h3>
                  <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {template.category.icon && <span className="mr-1">{template.category.icon}</span>}
                    {template.category.name}
                  </span>
                </div>
                {template.isFeatured && <StatusPill status="featured" />}
              </div>

              {template.shortDescription && (
                <p className="line-clamp-2 text-[13px] leading-relaxed text-foreground/80">
                  {template.shortDescription}
                </p>
              )}
              {template.philosophy && (
                <p className="border-l-2 border-muted-foreground/30 pl-3 text-xs italic leading-relaxed text-muted-foreground">
                  &ldquo;{template.philosophy}&rdquo;
                </p>
              )}

              <div className="border-t pt-3">
                <StatLine items={[count(template.mapCount, 'map')]} />
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
