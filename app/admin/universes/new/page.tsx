'use client';

import { useState, useEffect, useMemo, useRef, Suspense } from 'react';
import { DraftNotice } from '../../components/draft-notice';
import { useDraft } from '../../hooks/use-draft';
import { PageHeader } from '../../components/ds';
import { FORM_DRAFT_VERSION, addressFromName, upgradeFormDraft } from '@/lib/drafts';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, Loader2 } from 'lucide-react';

interface User {
  id: string;
  name: string | null;
  email: string | null;
}

// What was typed survives leaving the page (the owner is always the signed-in person, so it isn't kept).
// Version 2 also remembers whether the address was edited by hand; older drafts are upgraded on restore.
const EMPTY_UNIVERSE_DRAFT = {
  v: FORM_DRAFT_VERSION,
  slug: '',
  name: '',
  description: '',
  isPublic: true,
  featured: false,
  thumbnailUrl: '',
  addressEdited: false,
};
const upgradeUniverseDraft = (saved: unknown) => upgradeFormDraft(saved, EMPTY_UNIVERSE_DRAFT);

function NewUniversePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Came from "create a world" with no universe yet: go on to the world once this universe exists.
  const nextWorld = searchParams.get('next') === 'world';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setUser] = useState<User | null>(null);
  const [addressOpen, setAddressOpen] = useState(false);
  const slugInput = useRef<HTMLInputElement>(null);

  const [formData, setFormData] = useState({
    slug: '',
    name: '',
    description: '',
    ownerId: '',
    isPublic: true,
    featured: false,
    thumbnailUrl: '',
    addressEdited: false,
  });

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
    }),
    [formData.slug, formData.name, formData.description, formData.isPublic, formData.featured, formData.thumbnailUrl, formData.addressEdited],
  );
  const { discard: discardDraft, restored: draftRestored, revert: revertDraft } = useDraft(
    'universe.new',
    draftFields,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ({ v, ...draft }) => setFormData((prev) => ({ ...prev, ...draft })),
    EMPTY_UNIVERSE_DRAFT,
    true,
    upgradeUniverseDraft,
  );

  useEffect(() => {
    checkAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (addressOpen) slugInput.current?.focus();
  }, [addressOpen]);

  async function checkAuth() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }
      const data = await response.json();
      setUser(data.user);
      setFormData(prev => ({ ...prev, ownerId: data.user.id }));
    } catch {
      router.push('/admin/login');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (!formData.ownerId) {
      setError('Owner ID is missing. Please refresh the page and try again.');
      setLoading(false);
      return;
    }

    try {
      // The address flag is the form's own; the API gets the same fields as before.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { addressEdited, ...fields } = formData;
      const payload = {
        ...fields,
        description: formData.description || null,
        thumbnailUrl: formData.thumbnailUrl || null,
      };

      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/universes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = await response.json();
        const errorMessage = data.message || data.error || 'Failed to create universe';
        throw new Error(errorMessage);
      }

      const universe = await response.json();
      discardDraft();
      router.push(
        nextWorld ? `/admin/worlds/new?universeId=${encodeURIComponent(universe.id)}` : `/admin/universes/${universe.id}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create universe');
    } finally {
      setLoading(false);
    }
  }

  const showAddressInput = addressOpen || formData.addressEdited || (formData.name.trim() !== '' && formData.slug === '');

  return (
    <div className="space-y-6">
      <PageHeader
        kind="universe"
        title="New universe"
        context={
          <span>
            {nextWorld
              ? 'Your own space. Once it exists, you’ll add its first world.'
              : 'Your own space: its worlds and rooms live inside it.'}
          </span>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="p-4 sm:p-6">
          <form onSubmit={handleSubmit} className="space-y-6">
            {draftRestored && <DraftNotice onDiscard={revertDraft} />}
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
                placeholder="My Universe"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={showAddressInput ? 'slug' : undefined}>
                Address <span className="text-destructive">*</span>
              </Label>
              <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                Its rooms will open at{' '}
                <code className="rounded bg-muted px-1 text-foreground">
                  /@/{formData.slug || 'my-universe'}/…
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
                    placeholder="my-universe"
                  />
                  <p className="text-xs text-muted-foreground">Lowercase letters, numbers and dashes. Must be unique.</p>
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
                placeholder="A brief description of this universe"
              />
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <div className="flex min-h-11 items-center space-x-2">
                <Checkbox
                  id="isPublic"
                  checked={formData.isPublic}
                  onCheckedChange={(checked) => setFormData({ ...formData, isPublic: checked === true })}
                />
                <Label htmlFor="isPublic" className="flex min-h-11 cursor-pointer items-center font-normal">
                  Public
                </Label>
              </div>
              <div className="flex min-h-11 items-center space-x-2">
                <Checkbox
                  id="featured"
                  checked={formData.featured}
                  onCheckedChange={(checked) => setFormData({ ...formData, featured: checked === true })}
                />
                <Label htmlFor="featured" className="flex min-h-11 cursor-pointer items-center font-normal">
                  Featured
                </Label>
              </div>
            </div>

            <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" className="h-11" asChild>
                <Link href="/admin/universes">Cancel</Link>
              </Button>
              <Button type="submit" className="h-11" disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  'Create universe'
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default function NewUniversePage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <NewUniversePageContent />
    </Suspense>
  );
}
