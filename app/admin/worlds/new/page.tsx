'use client';

import { useIsSuperAdmin } from '../../admin-bootstrap-context';

import { useState, useEffect, useRef, Suspense, useMemo } from 'react';
import { DraftNotice } from '../../components/draft-notice';
import { useDraft } from '../../hooks/use-draft';
import { EmptyCard, InContext, KindIcon, LoadError, LoadingRows, PageHeader, SettingSwitch, Settings } from '../../components/ds';
import { FORM_DRAFT_VERSION, addressFromName, scopedDraftKey, upgradeFormDraft } from '@/lib/drafts';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, Loader2, AlertTriangle } from 'lucide-react';

interface Universe {
  id: string;
  name: string;
  slug: string;
}

// What was typed survives leaving the page. The universe comes from where you came from, so it isn't kept, unless it
// was picked here from several. Version 2 also remembers whether the address was edited by hand.
const EMPTY_WORLD_DRAFT = {
  v: FORM_DRAFT_VERSION,
  slug: '',
  name: '',
  description: '',
  isPublic: true,
  featured: false,
  thumbnailUrl: '',
  addressEdited: false,
  universeId: '',
};
const upgradeWorldDraft = (saved: unknown) => upgradeFormDraft(saved, EMPTY_WORLD_DRAFT);

function NewWorldPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const universeIdParam = searchParams.get('universeId');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [universes, setUniverses] = useState<Universe[]>([]);
  const [universesStatus, setUniversesStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [addressOpen, setAddressOpen] = useState(false);
  const slugInput = useRef<HTMLInputElement>(null);

  const isSuperAdmin = useIsSuperAdmin();
  const [formData, setFormData] = useState({
    universeId: universeIdParam || '',
    slug: '',
    name: '',
    description: '',
    isPublic: true,
    featured: false,
    thumbnailUrl: '',
    addressEdited: false,
  });

  // A universe picked here from several is part of the draft; one from the address, or the only one, isn't.
  const keepsUniverse = !universeIdParam && universes.length !== 1;
  const draftFields = useMemo(
    () => ({
      v: FORM_DRAFT_VERSION,
      slug: formData.slug,
      name: formData.name,
      description: formData.description,
      isPublic: formData.isPublic,
      featured: formData.featured,
      thumbnailUrl: formData.thumbnailUrl,
      addressEdited: formData.addressEdited,
      universeId: keepsUniverse ? formData.universeId : '',
    }),
    [formData.slug, formData.name, formData.description, formData.isPublic, formData.featured, formData.thumbnailUrl, formData.addressEdited, formData.universeId, keepsUniverse],
  );
  const { discard: discardDraft, restored: draftRestored, revert: revertDraft } = useDraft(
    scopedDraftKey('world.new', universeIdParam),
    draftFields,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ({ v, universeId, ...draft }) =>
      setFormData((prev) => ({ ...prev, ...draft, universeId: universeIdParam || universeId || prev.universeId })),
    EMPTY_WORLD_DRAFT,
    true,
    upgradeWorldDraft,
  );

  useEffect(() => {
    checkAuth();
    fetchUniverses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (addressOpen) slugInput.current?.focus();
  }, [addressOpen]);

  // Without a universe in the address: the only one is chosen for you; a choice that isn't yours any more is cleared.
  useEffect(() => {
    if (universeIdParam || universesStatus !== 'ready') return;
    setFormData((prev) => {
      if (universes.some((universe) => universe.id === prev.universeId)) return prev;
      const universeId = universes.length === 1 ? universes[0].id : '';
      return prev.universeId === universeId ? prev : { ...prev, universeId };
    });
  }, [universes, universesStatus, universeIdParam]);

  async function checkAuth() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }
    } catch {
      router.push('/admin/login');
    }
  }

  async function fetchUniverses() {
    setUniversesStatus('loading');
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      // Worlds can be created in the universes you own: the same rule the API applies.
      const response = await authenticatedFetch('/api/admin/universes?scope=my&limit=100');
      if (!response.ok) throw new Error('Failed to load universes');
      const data = await response.json();
      setUniverses(data.universes || []);
      setUniversesStatus('ready');
    } catch {
      if (universeIdParam) {
        try {
          const { authenticatedFetch } = await import('@/lib/client-auth');
          const universeResponse = await authenticatedFetch(`/api/admin/universes/${universeIdParam}`);
          if (!universeResponse.ok) throw new Error('Failed to load universe');
          setUniverses([await universeResponse.json()]);
          setUniversesStatus('ready');
        } catch {
          setUniversesStatus('error');
        }
      } else {
        setUniversesStatus('error');
      }
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!formData.universeId) {
      setError('Choose the universe this world belongs to.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // The address flag is the form's own; the API gets the same fields as before.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { addressEdited, ...fields } = formData;
      const payload = {
        ...fields,
        description: formData.description || null,
        thumbnailUrl: formData.thumbnailUrl || null,
        // Only super admins feature; anyone else's (an old draft's, say) stays off.
        featured: isSuperAdmin && formData.featured,
      };

      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/worlds', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = await response.json();
        const errorMessage = data.message || data.error || 'Failed to create world';
        throw new Error(errorMessage);
      }

      const world = await response.json();
      discardDraft();
      router.push(`/admin/worlds/${world.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create world');
    } finally {
      setLoading(false);
    }
  }

  const selectedUniverse = universes.find(u => u.id === formData.universeId);
  const noUniverse = !universeIdParam && universesStatus === 'ready' && universes.length === 0;
  const picking = !universeIdParam && universes.length > 1;
  const showAddressInput = addressOpen || formData.addressEdited || (formData.name.trim() !== '' && formData.slug === '');

  return (
    <div className="space-y-6">
      <PageHeader
        kind="world"
        title="New world"
        context={
          selectedUniverse ? (
            <InContext parts={[{ label: selectedUniverse.name, href: `/admin/universes/${selectedUniverse.id}` }]} />
          ) : (
            <span>A world belongs to a universe and holds its rooms.</span>
          )
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {universeIdParam && universesStatus === 'loading' && <LoadingRows label="the universe" rows={1} />}
      {universeIdParam && universesStatus === 'error' && <LoadError label="the universe" retry={fetchUniverses} />}
      {/* Loaded, but not one of yours: say so instead of waiting for it forever. */}
      {universeIdParam && universesStatus === 'ready' && !selectedUniverse && (
        <Alert data-testid="universe-not-yours">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>You can’t add worlds to this universe</AlertTitle>
          <AlertDescription>
            Worlds go in universes you own.{' '}
            <Link href="/admin/worlds/new" className="font-medium underline underline-offset-2">
              Choose one of yours
            </Link>
            .
          </AlertDescription>
        </Alert>
      )}

      {!universeIdParam && universesStatus === 'loading' && <LoadingRows label="your universes" />}
      {!universeIdParam && universesStatus === 'error' && <LoadError label="your universes" retry={fetchUniverses} />}
      {noUniverse && (
        <EmptyCard
          kind="universe"
          title="A world lives in a universe."
          text="You don’t have one yet. Create yours, then add this world to it."
          href="/admin/universes/new?next=world"
          action="Create a universe"
          testId="world-needs-universe"
        />
      )}

      {!noUniverse && (
        <Card>
          <CardContent className="p-4 sm:p-6">
            <form onSubmit={handleSubmit} className="space-y-6">
              {draftRestored && <DraftNotice onDiscard={revertDraft} />}
              <input type="hidden" name="universeId" value={formData.universeId} />

              {picking && (
                <UniverseChoice
                  universes={universes}
                  value={formData.universeId}
                  onChange={(universeId) => setFormData((prev) => ({ ...prev, universeId }))}
                />
              )}

              <div className="space-y-2">
                <Label htmlFor="name">
                  Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="name"
                  required
                  className="h-11"
                  value={formData.name}
                  onChange={(e) => {
                    const newName = e.target.value;
                    setFormData((prev) => ({
                      ...prev,
                      name: newName,
                      // The address follows the name until it's edited by hand.
                      slug: prev.addressEdited ? prev.slug : addressFromName(newName),
                    }));
                  }}
                  placeholder="Office Building"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor={showAddressInput ? 'slug' : undefined}>
                  Address <span className="text-destructive">*</span>
                </Label>
                <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  Its rooms will open at{' '}
                  <code className="rounded bg-muted px-1 text-foreground">
                    /@/{selectedUniverse?.slug || 'universe'}/{formData.slug || 'office-world'}/…
                  </code>
                </p>
                {showAddressInput ? (
                  <>
                    <Input
                      id="slug"
                      ref={slugInput}
                      required
                      className="h-11"
                      value={formData.slug}
                      onChange={(e) => {
                        const slug = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
                        setFormData((prev) => ({ ...prev, slug, addressEdited: true }));
                      }}
                      placeholder="office-world"
                    />
                    <p className="text-xs text-muted-foreground">
                      Lowercase letters, numbers and dashes. Must be unique within the universe.
                    </p>
                  </>
                ) : (
                  <Button type="button" variant="outline" className="h-11" onClick={() => setAddressOpen(true)}>
                    Change address
                  </Button>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  rows={3}
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="A brief description of this world"
                />
              </div>

              <Settings label="Visibility">
                <SettingSwitch
                  id="isPublic"
                  label="Public"
                  hint="Shown in Space, and its public rooms are open to everyone. Off: members only."
                  checked={formData.isPublic}
                  onChange={(checked) => setFormData({ ...formData, isPublic: checked })}
                />
                {isSuperAdmin && (
                  <SettingSwitch
                    id="featured"
                    label="Featured"
                    hint="Pinned to the top of Space and Discover. Only super admins can change this."
                    checked={formData.featured}
                    onChange={(checked) => setFormData({ ...formData, featured: checked })}
                  />
                )}
              </Settings>

              <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" className="h-11" asChild>
                  <Link href={formData.universeId ? `/admin/universes/${formData.universeId}` : '/admin'}>
                    Cancel
                  </Link>
                </Button>
                <Button type="submit" className="h-11" disabled={loading || !selectedUniverse}>
                  {loading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    'Create world'
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Which of your universes the world goes in: every one visible at once, a card each, nothing to drop down. */
function UniverseChoice({
  universes,
  value,
  onChange,
}: {
  universes: Universe[];
  value: string;
  onChange: (universeId: string) => void;
}) {
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="mb-2 text-sm font-medium">
        Universe <span className="text-destructive">*</span>
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {universes.map((universe) => (
          <label
            key={universe.id}
            className="flex min-h-11 min-w-0 cursor-pointer items-center gap-3 rounded-xl border border-border/70 px-3 py-2 transition-colors hover:bg-muted/50 has-[:checked]:border-foreground/40 has-[:checked]:bg-accent/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
          >
            <input
              type="radio"
              name="universe"
              value={universe.id}
              checked={value === universe.id}
              onChange={() => onChange(universe.id)}
              className="sr-only"
            />
            <KindIcon kind="universe" universeId={universe.id} size="sm" />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              <span className="block text-sm font-medium">{universe.name}</span>
              <span className="block text-xs text-muted-foreground">/@/{universe.slug}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default function NewWorldPage() {
  return (
    <Suspense fallback={
      <div className="space-y-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    }>
      <NewWorldPageContent />
    </Suspense>
  );
}
