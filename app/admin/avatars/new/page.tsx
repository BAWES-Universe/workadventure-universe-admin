'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import AuthLink from '@/app/admin/auth-link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, ArrowLeft, AlertCircle } from 'lucide-react';

export default function NewAvatarSetPage() {
  const router = useRouter();
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
      router.push(`/admin/avatars/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  if (checkingAuth) {
    return (
      <div className="flex items-center justify-center min-h-[300px]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <AuthLink href="/admin/avatars">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </AuthLink>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New Avatar Set</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Create a collection of woka layers and/or companions
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card className="border-border/50">
          <CardHeader>
            <CardTitle className="text-base">Basic Information</CardTitle>
            <CardDescription>Name, slug, and metadata for this avatar set</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="name">Name *</Label>
                <Input
                  id="name"
                  value={form.name}
                  onChange={e => {
                    setForm(f => ({ ...f, name: e.target.value, slug: autoSlug(e.target.value) }));
                  }}
                  placeholder="Default, Zoo Animals, Museum Staff..."
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="slug">Slug</Label>
                <Input
                  id="slug"
                  value={form.slug}
                  onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
                  placeholder="auto-generated"
                />
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
          </CardContent>
        </Card>

        <Card className="border-border/50">
          <CardHeader>
            <CardTitle className="text-base">Configuration</CardTitle>
            <CardDescription>Kind, visibility, and display order</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="kind">Kind</Label>
                <Select value={form.kind} onValueChange={v => setForm(f => ({ ...f, kind: v }))}>
                  <SelectTrigger id="kind"><SelectValue /></SelectTrigger>
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
                  <SelectTrigger id="visibility"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="public">Public — all players</SelectItem>
                    <SelectItem value="restricted">Restricted — policy gated</SelectItem>
                    <SelectItem value="hidden">Hidden — admin/bots only</SelectItem>
                    <SelectItem value="assigned_only">Assigned Only — direct grants</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="position">Display Order</Label>
                <Input
                  id="position"
                  type="number"
                  min={0}
                  value={form.position}
                  onChange={e => setForm(f => ({ ...f, position: e.target.value }))}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="flex items-center gap-3 justify-end">
          <AuthLink href="/admin/avatars">
            <Button type="button" variant="outline">Cancel</Button>
          </AuthLink>
          <Button type="submit" disabled={saving || !form.name}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Create Set
          </Button>
        </div>
      </form>
    </div>
  );
}