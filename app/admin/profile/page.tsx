'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Trash2, Plus, ExternalLink } from 'lucide-react';

interface LinkItem {
  label: string;
  url: string;
}

export default function VisitCardPage() {
  const router = useRouter();
  const [bio, setBio] = useState('');
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    checkAuth();
    fetchVisitCard();
  }, []);

  async function checkAuth() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
      }
    } catch (err) {
      router.push('/admin/login');
    }
  }

  async function fetchVisitCard() {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/profile');

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/admin/login');
          return;
        }
        throw new Error('Failed to fetch visit card');
      }

      const data = await response.json();
      setBio(data.bio || '');
      setLinks(data.links || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load visit card');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    try {
      setSaving(true);
      setError(null);
      setSuccess(false);

      // Validate URLs
      for (const link of links) {
        if (!link.label.trim()) {
          setError('All links must have a label');
          setSaving(false);
          return;
        }
        try {
          new URL(link.url);
        } catch {
          setError(`Invalid URL: ${link.url}`);
          setSaving(false);
          return;
        }
      }

      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/profile', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bio: bio.trim() || null,
          links: links.filter(link => link.label.trim() && link.url.trim()),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to save visit card');
      }

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save visit card');
    } finally {
      setSaving(false);
    }
  }

  function addLink() {
    setLinks([...links, { label: '', url: '' }]);
  }

  function removeLink(index: number) {
    setLinks(links.filter((_, i) => i !== index));
  }

  function updateLink(index: number, field: 'label' | 'url', value: string) {
    const updated = [...links];
    updated[index] = { ...updated[index], [field]: value };
    setLinks(updated);
  }

  if (loading) {
    return (
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="text-center py-12">
          <p className="text-gray-500">Loading visit card...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl">
        <div className="mb-6">
          <h1 className="text-3xl font-bold tracking-tight">Customize Visit Card</h1>
          <p className="mt-2 text-muted-foreground">
            Customize your public visit card that appears when other users click on you.
          </p>
        </div>

        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {success && (
          <Alert className="mb-4 border-green-200 bg-green-50 text-green-800">
            <AlertDescription>Visit card saved successfully!</AlertDescription>
          </Alert>
        )}

        <section className="space-y-6">
            {/* Bio */}
            <div className="space-y-2">
              <Label htmlFor="bio">Bio</Label>
              <Textarea
                id="bio"
                rows={4}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Tell others about yourself..."
              />
              <p className="text-xs text-muted-foreground">
                Optional. A brief description about yourself.
              </p>
            </div>

            {/* Links */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label>Links</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addLink}
                  className="gap-2"
                >
                  <Plus className="h-4 w-4" />
                  Add Link
                </Button>
              </div>

              {links.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">No links added yet.</p>
              ) : (
                <div className="space-y-3">
                  {links.map((link, index) => (
                    <div key={index} className="flex gap-3 items-start">
                      <div className="flex-1 space-y-2">
                        <Input
                          type="text"
                          placeholder="Label (e.g., LinkedIn)"
                          value={link.label}
                          onChange={(e) => updateLink(index, 'label', e.target.value)}
                        />
                        <Input
                          type="url"
                          placeholder="https://..."
                          value={link.url}
                          onChange={(e) => updateLink(index, 'url', e.target.value)}
                        />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeLink(index)}
                        className="mt-2 text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Add links to your social media profiles, website, meeting scheduling link or other resources.
              </p>
            </div>

            {/* Save Button */}
            <div className="flex justify-end pt-4">
              <Button
                type="button"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save Visit Card'}
              </Button>
            </div>
        </section>

        {/* Preview Section */}
        <section className="mt-6 space-y-4">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold tracking-tight">Preview</h2>
            <p className="text-sm text-muted-foreground">
              This is how your visit card will appear to others.
            </p>
          </div>
          <div>
            <div className="bg-gray-900 rounded-lg p-6 text-white">
              {bio || links.length > 0 ? (
                <div>
                  {bio && (
                    <div className="mb-4">
                      <p className="text-gray-300 whitespace-pre-wrap">{bio}</p>
                    </div>
                  )}
                  {links.length > 0 && (
                    <div className="space-y-2">
                      {links
                        .filter(link => link.label.trim() && link.url.trim())
                        .map((link, index) => (
                          <div
                            key={index}
                            className="bg-gray-800 rounded-lg px-4 py-3"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-medium">{link.label || 'Link'}</span>
                              <ExternalLink className="w-4 h-4 text-gray-400" />
                            </div>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-gray-500 text-center py-8">
                  Your visit card preview will appear here.
                </p>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

