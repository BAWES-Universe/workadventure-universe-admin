'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, ArrowLeft, Check } from 'lucide-react';

interface TemplateMap {
  id: string;
  slug: string;
  name: string;
  description?: string;
  mapUrl: string;
  sizeLabel?: string;
  order: number;
}

interface Category {
  id: string;
  slug: string;
  name: string;
  description?: string;
  icon?: string;
}

interface Template {
  id: string;
  slug: string;
  name: string;
  shortDescription?: string;
  philosophy?: string;
  purpose?: string;
  whoItsFor?: string;
  typicalUseCases?: string[];
  isFeatured: boolean;
  category: Category;
  maps: TemplateMap[];
}

interface TemplateDetailProps {
  templateSlug: string;
  onSelectMap: (mapId: string, mapUrl: string) => void;
  onBack: () => void;
  selectedMapId?: string;
}

export function TemplateDetail({
  templateSlug,
  onSelectMap,
  onBack,
  selectedMapId,
}: TemplateDetailProps) {
  const [template, setTemplate] = useState<Template | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchTemplate();
  }, [templateSlug]);

  async function fetchTemplate() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/templates/${templateSlug}`);
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Template not found');
        }
        throw new Error('Failed to fetch template');
      }

      const data = await response.json();
      setTemplate(data.template);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load template');
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !template) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={onBack} className="gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back to Templates
        </Button>
        <div className="rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          {error || 'Template not found'}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Button variant="ghost" onClick={onBack} className="gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            {template.category.icon && (
              <span className="text-3xl">{template.category.icon}</span>
            )}
            <div>
              <h2 className="text-3xl font-bold">{template.name}</h2>
              <p className="text-muted-foreground mt-1">{template.shortDescription}</p>
            </div>
            {template.isFeatured && (
              <Badge variant="secondary">Featured</Badge>
            )}
          </div>
          <Badge variant="outline" className="mt-2">
            {template.category.name}
          </Badge>
        </div>
      </div>

      {/* Map Variants */}
      <div>
        <h3 className="text-xl font-semibold mb-4">Available Maps</h3>
        {template.maps.length === 0 ? (
          <div className="rounded-lg border p-4 text-center text-muted-foreground">
            No maps available for this template.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {template.maps.map((map) => {
              const isSelected = selectedMapId === map.id;
              return (
                <Card
                  key={map.id}
                  className={`cursor-pointer transition-all ${
                    isSelected
                      ? 'ring-2 ring-primary'
                      : 'hover:shadow-md'
                  }`}
                  onClick={() => onSelectMap(map.id, map.mapUrl)}
                >
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <CardTitle className="text-lg">{map.name}</CardTitle>
                      {isSelected && (
                        <Check className="h-5 w-5 text-primary" />
                      )}
                    </div>
                    {map.description && (
                      <CardDescription>{map.description}</CardDescription>
                    )}
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between">
                      {map.sizeLabel && (
                        <Badge variant="outline">{map.sizeLabel}</Badge>
                      )}
                      <Button
                        variant={isSelected ? 'default' : 'outline'}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectMap(map.id, map.mapUrl);
                        }}
                      >
                        {isSelected ? 'Selected' : 'Use this map'}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

