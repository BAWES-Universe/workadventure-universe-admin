'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import AuthLink from '@/app/admin/auth-link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, AlertCircle } from 'lucide-react';
import { LoadingRows, PageHeader } from '../../components/ds';
import { useReplacePage } from '@/app/admin/orbit-frame-context';

export default function NewAvatarSetPage() {
  const router = useRouter();
  const replacePage = useReplacePage();
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: '',
    slug: '',
    description: '',
    kind: 'woka',
    visibility: 'public',
    position: '0',
  });

  function autoSlug(name: string) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  useEffect(() => {
    async function init() {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      try {
        const res = await authenticatedFetch('/api/auth/me');
        if (!res.ok) { router.push('/admin/login'); return; }
      } catch {
        router.push('/admin/login');
        return;
      }
      setCheckingAuth(false);
    }
    init();
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const res = await authenticatedFetch('/api/admin/avatar-sets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          slug: form.slug || autoSlug(form.name) || 'untitled',
          description: form.description || null,
          kind: form.kind,
          visibility: form.visibility,
          position: parseInt(form.position) || 0,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create set');
      replacePage(`/admin/avatars/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  if (checkingAuth) {
    return (
      <div className="grid min-w-0 gap-6">
        <PageHeader kind="avatar" title="New avatar set" />
        <LoadingRows label="the form" rows={3} />
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        kind="avatar"
        title="New avatar set"
        context={<span className="text-sm text-muted-foreground">A collection of woka layers, companions, or both.</span>}
      />

      <form onSubmit={handleSubmit} className="grid min-w-0 gap-6 rounded-2xl border bg-card p-4 sm:p-5">
        <fieldset className="grid min-w-0 gap-4">
          <legend className="orbit-display mb-1 text-base font-semibold">Name and description</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="name"
                className="h-11"
                value={form.name}
                onChange={e => {
                  setForm(f => ({ ...f, name: e.target.value, slug: autoSlug(e.target.value) }));
                }}
                placeholder="Default, Zoo Animals, Museum Staff..."
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="slug">Set key</Label>
              <Input
                id="slug"
                className="h-11 font-mono"
                value={form.slug}
                onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
                placeholder="auto-generated"
                aria-describedby="slug-hint"
              />
              <p id="slug-hint" className="text-xs text-muted-foreground">Follows the name. Used to refer to the set; can’t be changed later.</p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="desc">Description</Label>
            <Textarea
              id="desc"
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="What's this set for?"
              rows={3}
            />
          </div>
        </fieldset>

        <fieldset className="grid min-w-0 gap-4">
          <legend className="orbit-display mb-1 text-base font-semibold">Kind, visibility and order</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="kind">Kind</Label>
              <Select value={form.kind} onValueChange={v => setForm(f => ({ ...f, kind: v }))}>
                <SelectTrigger id="kind" className="h-11"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="woka">Woka</SelectItem>
                  <SelectItem value="companion">Companion</SelectItem>
                  <SelectItem value="mixed">Mixed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="visibility">Visibility</Label>
              <Select value={form.visibility} onValueChange={v => setForm(f => ({ ...f, visibility: v }))}>
                <SelectTrigger id="visibility" className="h-11"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">Public — all players</SelectItem>
                  <SelectItem value="restricted">Restricted — policy gated</SelectItem>
                  <SelectItem value="hidden">Hidden — admin/bots only</SelectItem>
                  <SelectItem value="assigned_only">Assigned only — direct grants</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="position">Display order</Label>
              <Input
                id="position"
                className="h-11"
                type="number"
                min={0}
                value={form.position}
                onChange={e => setForm(f => ({ ...f, position: e.target.value }))}
              />
            </div>
          </div>
        </fieldset>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" className="h-11" asChild>
            <AuthLink href="/admin/avatars">Cancel</AuthLink>
          </Button>
          <Button type="submit" className="h-11" disabled={saving || !form.name}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create set
          </Button>
        </div>
      </form>
    </div>
  );
}
