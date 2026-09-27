'use client';

import Link from 'next/link';
import { Globe, Building2, Star, Plus, Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAdminBootstrap } from '../admin-bootstrap-context';
import { SectionHeading, StatTile } from './shell/list-row';

/**
 * The person's own places: the universes they own, the worlds they belong to, the rooms they starred. A newcomer
 * with none of them gets one clear invitation to make a universe, and one to explore.
 */
export default function YourPlaces() {
  const { mine } = useAdminBootstrap();
  const counts = mine ?? { universes: 0, worlds: 0, stars: 0, invitations: 0 };
  const nothingYet = counts.universes === 0 && counts.worlds === 0 && counts.stars === 0;

  if (nothingYet) {
    return (
      <section className="orbit-card overflow-hidden" data-testid="your-places-empty">
        <div
          className="h-1.5 w-full"
          style={{ background: 'linear-gradient(90deg, var(--brand-purple), var(--brand-blue), var(--brand-gold))' }}
        />
        <div className="space-y-4 p-5">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Make a place of your own</h2>
            <p className="text-sm text-muted-foreground">
              A universe holds your worlds and rooms. It takes a minute, and you can shape it later.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button asChild className="orbit-brand-fill border-0 hover:opacity-90">
              <Link href="/admin/universes/new">
                <Plus className="h-4 w-4" />
                Create a universe
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/admin/places?tab=explore">
                <Compass className="h-4 w-4" />
                Explore first
              </Link>
            </Button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section data-testid="your-places">
      <SectionHeading
        title="Your places"
        action={
          <Link href="/admin/places" className="font-medium text-primary hover:underline">
            See all
          </Link>
        }
      />
      <div className="grid grid-cols-3 gap-3">
        <StatTile href="/admin/universes" icon={Globe} value={counts.universes} label={counts.universes === 1 ? 'Universe' : 'Universes'} />
        <StatTile href="/admin/memberships" icon={Building2} value={counts.worlds} label={counts.worlds === 1 ? 'World' : 'Worlds'} accent="muted" />
        <StatTile href="/admin/stars" icon={Star} value={counts.stars} label={counts.stars === 1 ? 'Star' : 'Stars'} accent="gold" />
      </div>
    </section>
  );
}
