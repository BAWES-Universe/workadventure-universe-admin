'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [accessToken, setAccessToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ accessToken }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Login failed');
      }

      // Redirect to admin dashboard
      router.push('/admin');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            Sign in to Admin
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Use your OIDC access token to login
          </p>
        </div>
        <form className="mt-8 space-y-6" onSubmit={handleLogin}>
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-4">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
          
          <div>
            <label htmlFor="accessToken" className="block text-sm font-medium text-gray-700">
              OIDC Access Token
            </label>
            <div className="mt-1">
              <input
                id="accessToken"
                name="accessToken"
                type="text"
                required
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                className="appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                placeholder="Enter your OIDC access token"
              />
            </div>
            <p className="mt-2 text-sm text-gray-500">
              Get your access token from WorkAdventure after logging in, or use the OIDC mock test token.
            </p>
          </div>

          <div>
            <button
              type="submit"
              disabled={loading}
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </div>

          <div className="text-sm text-gray-600">
            <p className="font-medium">For Testing:</p>
            <p className="mt-1">
              If using OIDC mock, you can get a token by:
            </p>
            <ol className="list-decimal list-inside mt-2 space-y-1">
              <li>Logging into WorkAdventure at <code className="bg-gray-100 px-1 rounded">http://play.workadventure.localhost</code></li>
              <li>Check browser DevTools → Network → Look for API calls with <code className="bg-gray-100 px-1 rounded">accessToken</code> parameter</li>
              <li>Or use the OIDC mock directly to get a token</li>
            </ol>
          </div>
        </form>
      </div>
    </div>
  );
}

