'use client';

import { useState, useEffect, useRef } from 'react';
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
  previewImageUrl?: string | null;
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
  hideBackButton?: boolean;
}

function MapCardWithImage({ map, isSelected, onSelectMap }: { map: TemplateMap; isSelected: boolean; onSelectMap: (mapId: string, mapUrl: string) => void }) {
  const [imageReady, setImageReady] = useState(false);
  const [imageError, setImageError] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);

  // Reset states when previewImageUrl changes
  useEffect(() => {
    setImageReady(false);
    setImageError(false);
    
    // Check if image is already cached
    if (map.previewImageUrl) {
      const img = new Image();
      img.onload = () => setImageReady(true);
      img.onerror = () => setImageError(true);
      img.src = map.previewImageUrl;
    }
  }, [map.previewImageUrl]);

  return (
    <Card
      className={`cursor-pointer transition-all group relative overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background ${
        isSelected
          ? 'ring-2 ring-primary shadow-lg'
          : 'hover:-translate-y-1 hover:shadow-lg'
      }`}
      onClick={() => onSelectMap(map.id, map.mapUrl)}
    >
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-blue-500/10 via-transparent to-indigo-500/20 opacity-0 transition-opacity group-hover:opacity-100" />
      
      {/* Preview Image - only show container after image successfully loaded
          If no previewImageUrl or image errors, nothing renders (no grey area) */}
      {map.previewImageUrl && imageReady && !imageError && (
        <div className="relative w-full h-48 overflow-hidden bg-muted">
          <img
            ref={imageRef}
            src={map.previewImageUrl}
            alt={map.name}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
          {isSelected && (
            <div className="absolute top-2 right-2 z-10">
              <div className="bg-primary text-primary-foreground rounded-full p-1.5 shadow-lg">
                <Check className="h-4 w-4" />
              </div>
            </div>
          )}
        </div>
      )}
      
      <CardHeader className="relative">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <CardTitle className="text-base font-semibold leading-tight mb-1">{map.name}</CardTitle>
            {map.sizeLabel && (
              <Badge variant="secondary" className="text-xs">
                {map.sizeLabel.charAt(0).toUpperCase() + map.sizeLabel.slice(1).toLowerCase()} size
              </Badge>
            )}
          </div>
          {isSelected && (!map.previewImageUrl || imageError || !imageReady) && (
            <Check className="h-5 w-5 text-primary flex-shrink-0" />
          )}
        </div>
        {map.description && (
          <CardDescription className="mt-3">{map.description}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="relative">
        <Button
          variant={isSelected ? 'default' : 'outline'}
          size="sm"
          className="w-full"
          onClick={(e) => {
            e.stopPropagation();
            onSelectMap(map.id, map.mapUrl);
          }}
        >
          {isSelected ? 'Selected' : 'Use this map'}
        </Button>
      </CardContent>
    </Card>
  );
}

export function TemplateDetail({
  templateSlug,
  onSelectMap,
  onBack,
  selectedMapId,
  hideBackButton = false,
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
      <Card className="border-border/70 bg-gradient-to-br from-background via-background to-background relative">
        {template.isFeatured && (
          <div className="absolute top-4 right-4 z-10">
            <Badge variant="outline" className="text-xs">Featured</Badge>
          </div>
        )}
        <CardHeader>
          <div className="space-y-4">
            <div className={template.isFeatured ? 'pr-20' : ''}>
              <h2 className="text-xl font-bold tracking-tight">{template.name}</h2>
              <div className="flex items-center gap-1.5 mt-2">
                {template.category.icon && (
                  <span className="text-sm">{template.category.icon}</span>
                )}
                <p className="text-xs text-muted-foreground">
                  {template.category.name}
                </p>
              </div>
            </div>
            
            {template.shortDescription && (
              <p className="text-foreground text-lg">
                {template.shortDescription}
              </p>
            )}
            
            {template.philosophy && (
              <div>
                <h4 className="text-sm font-semibold mb-2">Philosophy</h4>
                <div className="border-l-2 border-muted-foreground/30 pl-4">
                  <p className="text-sm italic text-muted-foreground leading-relaxed">
                    &ldquo;{template.philosophy}&rdquo;
                  </p>
                </div>
              </div>
            )}
          </div>
        </CardHeader>
        
        {(template.purpose || template.whoItsFor || template.typicalUseCases?.length) && (
          <CardContent className="space-y-4 pt-0">
            {template.purpose && (
              <div>
                <h4 className="text-sm font-semibold mb-1">Purpose</h4>
                <p className="text-sm text-muted-foreground">{template.purpose}</p>
              </div>
            )}
            
            {template.whoItsFor && (
              <div>
                <h4 className="text-sm font-semibold mb-1">Who It's For</h4>
                <p className="text-sm text-muted-foreground">{template.whoItsFor}</p>
              </div>
            )}
            
            {template.typicalUseCases && template.typicalUseCases.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold mb-2">Typical Use Cases</h4>
                <div className="flex flex-wrap gap-2">
                  {template.typicalUseCases.map((useCase, index) => (
                    <span
                      key={index}
                      className="inline-flex items-center rounded-md bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
                    >
                      {useCase}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Map Variants */}
      <div>
        <div className="mb-4">
          <h3 className="text-xl font-semibold mb-1">Select Map</h3>
          <p className="text-sm text-muted-foreground">Choose from the available maps.</p>
        </div>
        {template.maps.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No maps available for this template.
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {template.maps.map((map) => {
              const isSelected = selectedMapId === map.id;
              return (
                <MapCardWithImage
                  key={map.id}
                  map={map}
                  isSelected={isSelected}
                  onSelectMap={onSelectMap}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

