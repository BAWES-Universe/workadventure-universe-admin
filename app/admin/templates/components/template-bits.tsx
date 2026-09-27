'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { KindIcon } from '../../components/ds';

/** A template, category or map hidden from the library: a neutral pill, never a colour block. */
export function InactivePill() {
  return (
    <span className="inline-flex h-[22px] items-center rounded-full border border-foreground/15 px-2 text-[11px] font-semibold text-foreground/85">
      Inactive
    </span>
  );
}

/**
 * A map in a list: the EntityCard idiom with its preview image on top. The whole card is the link. The preview only
 * shows once it has loaded, so a broken image leaves no grey box.
 */
export function MapCard({
  href,
  title,
  previewImageUrl,
  description,
  pills,
  meta,
}: {
  href: string;
  title: string;
  previewImageUrl?: string | null;
  description?: string | null;
  pills?: ReactNode;
  meta?: ReactNode;
}) {
  // Which preview has loaded or failed; a new URL starts over.
  const [loaded, setLoaded] = useState<{ url: string; ok: boolean } | null>(null);
  const settled = loaded && loaded.url === previewImageUrl ? loaded : null;
  const imageReady = settled?.ok === true;
  const imageError = settled?.ok === false;

  return (
    <article className="group relative grid min-w-0 overflow-hidden rounded-[18px] border bg-card transition-[border-color,transform] hover:-translate-y-px hover:border-foreground/20 motion-reduce:transform-none">
      {previewImageUrl && !imageReady && !imageError && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={previewImageUrl}
          alt=""
          className="pointer-events-none absolute opacity-0"
          style={{ width: 1, height: 1 }}
          onLoad={() => setLoaded({ url: previewImageUrl, ok: true })}
          onError={() => setLoaded({ url: previewImageUrl, ok: false })}
        />
      )}
      {previewImageUrl && imageReady && !imageError && (
        <div className="h-44 w-full overflow-hidden border-b bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewImageUrl} alt="" className="h-full w-full object-cover" />
        </div>
      )}
      <div className="grid gap-3 p-4">
        <div className="flex items-start gap-3">
          <KindIcon kind="map" />
          <div className="grid min-w-0 flex-1 gap-1">
            <h3 className="text-base font-bold leading-snug [overflow-wrap:anywhere]">
              <Link
                href={href}
                className="outline-none after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring"
              >
                {title}
              </Link>
            </h3>
          </div>
          <ArrowUpRight className="h-4 w-4 flex-none text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true" />
        </div>
        {pills && <div className="flex flex-wrap gap-1.5">{pills}</div>}
        {description && <p className="line-clamp-2 text-[13px] leading-relaxed text-foreground/80">{description}</p>}
        {meta && <div className="grid gap-1.5 border-t pt-3">{meta}</div>}
      </div>
    </article>
  );
}

/** A neutral outline pill for plain facts such as a map's size. */
export function FactPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[22px] items-center rounded-full border border-foreground/15 px-2 text-[11px] font-semibold text-foreground/85">
      {children}
    </span>
  );
}
