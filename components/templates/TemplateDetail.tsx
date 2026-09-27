'use client';

import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { KindIcon, LoadError, LoadingRows, StatusPill } from '@/app/admin/components/ds';

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

  const sizeText = map.sizeLabel ? `${map.sizeLabel.charAt(0).toUpperCase()}${map.sizeLabel.slice(1).toLowerCase()} size` : null;

  return (
    <article
      className={cn(
        'group relative grid min-w-0 overflow-hidden rounded-[18px] border bg-card transition-[border-color,transform] motion-reduce:transform-none',
        isSelected ? 'border-foreground/60 ring-1 ring-foreground/40' : 'hover:-translate-y-px hover:border-foreground/20',
      )}
    >
      {/* Preview Image - only show container after image successfully loaded
          If no previewImageUrl or image errors, nothing renders (no grey area) */}
      {map.previewImageUrl && imageReady && !imageError && (
        <div className="relative h-44 w-full overflow-hidden border-b bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imageRef}
            src={map.previewImageUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        </div>
      )}

      <div className="grid gap-3 p-4">
        <div className="flex items-start gap-3">
          <KindIcon kind="map" />
          <div className="grid min-w-0 flex-1 gap-1">
            <h4 className="text-base font-bold leading-snug [overflow-wrap:anywhere]">
              <button
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelectMap(map.id, map.mapUrl)}
                className="text-left outline-none after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring"
              >
                {map.name}
              </button>
            </h4>
            {sizeText && <span className="text-xs text-muted-foreground">{sizeText}</span>}
          </div>
        </div>
        {map.description && <p className="text-[13px] leading-relaxed text-foreground/80">{map.description}</p>}
        <span
          aria-hidden="true"
          className={cn(
            'inline-flex h-11 items-center justify-center gap-2 rounded-md border text-sm font-medium transition-colors',
            isSelected ? 'border-foreground/60 bg-foreground/5 text-foreground' : 'text-foreground/85 group-hover:bg-foreground/5',
          )}
        >
          {isSelected && <Check className="h-4 w-4" />}
          {isSelected ? 'Selected' : 'Use this map'}
        </span>
      </div>
    </article>
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
    return <LoadingRows label="the template" rows={3} />;
  }

  if (error || !template) {
    return (
      <div className="space-y-4">
        <Button variant="outline" onClick={onBack} className="h-11 gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back to templates
        </Button>
        {error && error !== 'Template not found' ? (
          <LoadError label="this template" retry={fetchTemplate} />
        ) : (
          <p className="text-sm text-muted-foreground">This template no longer exists.</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-4 rounded-2xl border bg-card p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <KindIcon kind="template" />
          <div className="min-w-0 flex-1">
            <h2 className="orbit-display text-xl font-bold [overflow-wrap:anywhere]">{template.name}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {template.category.icon && <span className="mr-1">{template.category.icon}</span>}
              {template.category.name}
            </p>
          </div>
          {template.isFeatured && <StatusPill status="featured" />}
        </div>

        {template.shortDescription && (
          <p className="text-base text-foreground">
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

        {template.purpose && (
          <div>
            <h4 className="text-sm font-semibold mb-1">Purpose</h4>
            <p className="text-sm text-muted-foreground">{template.purpose}</p>
          </div>
        )}

        {template.whoItsFor && (
          <div>
            <h4 className="text-sm font-semibold mb-1">Who it’s for</h4>
            <p className="text-sm text-muted-foreground">{template.whoItsFor}</p>
          </div>
        )}

        {template.typicalUseCases && template.typicalUseCases.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold mb-2">Typical use cases</h4>
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
      </div>

      {/* Map Variants */}
      <section aria-labelledby="template-detail-maps">
        <div className="mb-3">
          <h3 id="template-detail-maps" className="orbit-display text-lg font-bold">Choose a map</h3>
        </div>
        {template.maps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No maps available for this template.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
      </section>
    </div>
  );
}
