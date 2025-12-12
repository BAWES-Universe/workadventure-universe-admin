'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

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
      {/* Breadcrumbs */}
      <nav className="flex mb-6" aria-label="Breadcrumb">
        <ol className="flex items-center space-x-4">
          <li>
            <Link href="/admin" className="text-gray-400 hover:text-gray-500">
              Dashboard
            </Link>
          </li>
          <li>
            <span className="text-gray-500 mx-2">/</span>
          </li>
          <li className="text-gray-900">Visit Card</li>
        </ol>
      </nav>

      <div className="max-w-4xl">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900">Customize Visit Card</h1>
          <p className="mt-2 text-sm text-gray-700">
            Customize your public visit card that appears when other users click on you in WorkAdventure.
          </p>
        </div>

        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 rounded-md p-4">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {success && (
          <div className="mb-4 bg-green-50 border border-green-200 rounded-md p-4">
            <p className="text-sm text-green-800">Visit card saved successfully!</p>
          </div>
        )}

        <div className="bg-white shadow rounded-lg p-6">
          {/* Bio */}
          <div className="mb-6">
            <label htmlFor="bio" className="block text-sm font-medium text-gray-700 mb-2">
              Bio
            </label>
            <textarea
              id="bio"
              rows={4}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
              placeholder="Tell others about yourself..."
            />
            <p className="mt-1 text-xs text-gray-500">
              Optional. A brief description about yourself.
            </p>
          </div>

          {/* Links */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700">
                Links
              </label>
              <button
                type="button"
                onClick={addLink}
                className="text-sm text-indigo-600 hover:text-indigo-900 font-medium"
              >
                + Add Link
              </button>
            </div>

            {links.length === 0 ? (
              <p className="text-sm text-gray-500 italic">No links added yet.</p>
            ) : (
              <div className="space-y-3">
                {links.map((link, index) => (
                  <div key={index} className="flex gap-3 items-start">
                    <div className="flex-1">
                      <input
                        type="text"
                        placeholder="Label (e.g., LinkedIn)"
                        value={link.label}
                        onChange={(e) => updateLink(index, 'label', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 mb-2"
                      />
                      <input
                        type="url"
                        placeholder="https://..."
                        value={link.url}
                        onChange={(e) => updateLink(index, 'url', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeLink(index)}
                      className="mt-2 px-3 py-2 text-sm text-red-600 hover:text-red-900"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-2 text-xs text-gray-500">
              Add links to your social media profiles, website, or other resources.
            </p>
          </div>

          {/* Save Button */}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : 'Save Visit Card'}
            </button>
          </div>
        </div>

        {/* Preview Section */}
        <div className="mt-6 bg-white shadow rounded-lg p-6">
          <h2 className="text-lg font-medium text-gray-900 mb-4">Preview</h2>
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
                            <svg
                              className="w-4 h-4 text-gray-400"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                              />
                            </svg>
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
      </div>
    </div>
  );
}

