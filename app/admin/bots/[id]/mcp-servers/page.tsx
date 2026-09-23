'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { summarizeTestResult, type McpTestResult } from '@/lib/mcp/test-result';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Loader2,
  Plus,
  Trash2,
  TestTube,
  Wifi,
  WifiOff,
  ExternalLink,
  ArrowLeft,
  Server,
} from 'lucide-react';

interface McpServer {
  id: string;
  botId: string;
  name: string;
  serverUrl: string;
  authType: string;
  oauthConnected?: boolean;
  /** True when refreshing is impossible and only a human re-authorization can fix it. */
  oauthReconnectRequired?: boolean;
  oauthReconnectReason?: string | null;
  /** Access-token expiry (ISO). Absent for non-OAuth and for configs predating expiry capture. */
  oauthExpiresAt?: string | null;
  enabled: boolean;
  headers?: Record<string, string>;
  lastTestedAt?: string | null;
  lastTestResult?: McpTestResult | null;
  createdAt: string;
  updatedAt: string;
}

interface McpServerFormData {
  name: string;
  serverUrl: string;
  authType: string;
  authConfig: string;
  headers: { key: string; value: string }[];
  enabled: boolean;
  // OAuth-specific fields (serialized into authConfig on save)
  oauthAuthorizeUrl?: string;
  oauthTokenUrl?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthScopes?: string;
}

const emptyForm: McpServerFormData = {
  name: '',
  serverUrl: '',
  authType: 'none',
  authConfig: '',
  headers: [],
  enabled: true,
  oauthAuthorizeUrl: '',
  oauthTokenUrl: '',
  oauthClientId: '',
  oauthClientSecret: '',
  oauthScopes: '',
};

export default function BotMcpServersPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const [botId, setBotId] = useState<string>('');
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  // Add dialog state
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [formData, setFormData] = useState<McpServerFormData>(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Reset add-dialog state when closed so stale discovery/form data
  // doesn't persist to the next open (e.g., "Auto-configured" showing
  // for a new URL before discovery actually runs)
  const handleAddDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setFormData(emptyForm);
      setFormError(null);
      setOauthDiscovery('idle');
      setDiscoveredAuthUrl('');
      setDiscoveredTokenUrl('');
      setDiscoveredScopes(null);
      setDiscoveryRegistration(null);
      setDiscoveryAuthMethod(null);
    }
    setAddDialogOpen(open);
  }, []);

  // Delete dialog state
  const [deleteServerId, setDeleteServerId] = useState<string | null>(null);

  // OAuth discovery state
  const [oauthDiscovery, setOauthDiscovery] = useState<'idle' | 'discovering' | 'discovered' | 'not_found'>('idle');
  const [discoveredAuthUrl, setDiscoveredAuthUrl] = useState('');
  const [discoveredTokenUrl, setDiscoveredTokenUrl] = useState('');
  const [discoveredScopes, setDiscoveredScopes] = useState<string[] | null>(null);
  const [discoveryRegistration, setDiscoveryRegistration] = useState<'auto' | 'manual' | null>(null);
  const [discoveryAuthMethod, setDiscoveryAuthMethod] = useState<string | null>(null);

  // Trigger OAuth discovery when serverUrl + authType = oauth
  // Debounce: only fire when user stops typing for 500ms
  useEffect(() => {
    // Reset discovery state whenever serverUrl changes to avoid carrying
    // stale OAuth endpoints from a previous URL (CodeRabbit Major)
    setOauthDiscovery('idle');
    setDiscoveredAuthUrl('');
    setDiscoveredTokenUrl('');
    setDiscoveredScopes(null);
    setDiscoveryRegistration(null);
    setDiscoveryAuthMethod(null);

    if (formData.authType !== 'oauth' || !formData.serverUrl.trim()) {
      return;
    }
    // Only trigger discovery if URL looks valid
    if (!/^https?:\/\/.+/i.test(formData.serverUrl.trim())) {
      setOauthDiscovery('not_found');
      return;
    }
    const abortController = new AbortController();
    const timer = setTimeout(async () => {
      setOauthDiscovery('discovering');
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const res = await authenticatedFetch(
          `/api/mcp/oauth-discover?serverUrl=${encodeURIComponent(formData.serverUrl)}`,
          { signal: abortController.signal }
        );
        if (abortController.signal.aborted) return;
        if (!res.ok) {
          setOauthDiscovery('not_found');
          return;
        }
        const data = await res.json();
        if (abortController.signal.aborted) return;
        if (data.discovered) {
          setDiscoveredAuthUrl(data.authorizeUrl || '');
          setDiscoveredTokenUrl(data.tokenUrl || '');
          setDiscoveredScopes(data.scopesSupported || null);
          setDiscoveryRegistration(data.registrationStatus || null);
          setDiscoveryAuthMethod(data.registeredAuthMethod || null);
          setOauthDiscovery('discovered');
          // Auto-fill form with discovered endpoints + any registered credentials
          setFormData((prev) => ({
            ...prev,
            oauthAuthorizeUrl: prev.oauthAuthorizeUrl || data.authorizeUrl || '',
            oauthTokenUrl: prev.oauthTokenUrl || data.tokenUrl || '',
            oauthClientId: prev.oauthClientId || data.clientId || '',
            oauthClientSecret: prev.oauthClientSecret || data.clientSecret || '',
          }));
        } else {
          setOauthDiscovery('not_found');
        }
      } catch {
        if (!abortController.signal.aborted) setOauthDiscovery('not_found');
      }
    }, 500);
    return () => {
      clearTimeout(timer);
      abortController.abort();
    };
  }, [formData.serverUrl, formData.authType]);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { result: McpTestResult; testedAt: Date }>
  >({});

  useEffect(() => {
    async function init() {
      const resolvedParams = await params;
      setBotId(resolvedParams.id);

      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch('/api/auth/me');
        if (!response.ok) {
          router.push('/admin/login');
          return;
        }
        setAuthChecked(true);
      } catch {
        router.push('/admin/login');
      }
    }
    init();
  }, [params, router]);

  const fetchServers = useCallback(async () => {
    if (!botId || !authChecked) return;
    try {
      setLoading(true);
      setError(null);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/bots/${botId}/mcp-servers`);
      if (!response.ok) {
        if (response.status === 404) {
          setError('Bot not found');
          return;
        }
        throw new Error('Failed to fetch MCP servers');
      }
      const data = await response.json();
      setServers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [botId, authChecked]);

  useEffect(() => {
    if (botId && authChecked) {
      fetchServers();
    }
  }, [botId, authChecked, fetchServers]);

  async function handleCreate() {
    setSubmitting(true);
    setFormError(null);

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/bots/${botId}/mcp-servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          serverUrl: formData.serverUrl,
          authType: formData.authType,
          authConfig: formData.authType === 'oauth'
            ? JSON.stringify({
                authorizeUrl: formData.oauthAuthorizeUrl?.trim() || null,
                tokenUrl: formData.oauthTokenUrl?.trim() || null,
                clientId: (discoveryRegistration === 'auto' && !formData.oauthClientId?.trim()) ? null : (formData.oauthClientId?.trim() || null),
                clientSecret: (discoveryRegistration === 'auto' && !formData.oauthClientSecret?.trim()) ? null : (formData.oauthClientSecret?.trim() || null),
                scopes: formData.oauthScopes?.trim() || null,
                // What the authorization server says it publishes. Recorded so the
                // authorize request can ask for `offline_access` only when the server
                // actually offers it (#187).
                scopesSupported: discoveredScopes && discoveredScopes.length > 0 ? discoveredScopes : undefined,
              })
            : formData.authConfig || null,
          headers: formData.headers.length > 0
            ? Object.fromEntries(formData.headers.filter(h => h.key.trim()).map(h => [h.key.trim(), h.value]))
            : undefined,
          enabled: formData.enabled,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        if (response.status === 422) {
          setFormError('Maximum of 5 MCP servers per bot reached');
        } else {
          setFormError(data.error || 'Failed to create MCP server');
        }
        return;
      }

      handleAddDialogOpenChange(false);
      await fetchServers();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggle(server: McpServer) {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/bots/${botId}/mcp-servers/${server.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !server.enabled }),
      });

      if (!response.ok) throw new Error('Failed to update');

      setServers((prev) =>
        prev.map((s) => (s.id === server.id ? { ...s, enabled: !s.enabled } : s))
      );
    } catch (err) {
      console.error('Error toggling server:', err);
    }
  }

  async function handleDelete() {
    if (!deleteServerId) return;

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/bots/${botId}/mcp-servers/${deleteServerId}`, {
        method: 'DELETE',
      });

      if (!response.ok) throw new Error('Failed to delete');

      setDeleteServerId(null);
      setServers((prev) => prev.filter((s) => s.id !== deleteServerId));
    } catch (err) {
      console.error('Error deleting server:', err);
    }
  }

  // Bumped for a server when it is reconnected. A test started before the reconnect
  // describes the old authorization, so its result is discarded when it lands (#193 review).
  const testGenerationRef = useRef<Record<string, number>>({});

  async function handleTestConnection(server: McpServer) {
    setTestingId(server.id);
    const generation = testGenerationRef.current[server.id] ?? 0;
    const isCurrent = () => (testGenerationRef.current[server.id] ?? 0) === generation;

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/bots/${botId}/mcp-servers/${server.id}/test`, {
        method: 'POST',
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${response.statusText}${text ? ' — ' + text : ''}`);
      }

      const data = await response.json();

      // Keep the failure detail the API captured (error code, WWW-Authenticate)
      // so the row shows the cause immediately, not just the status text (#186).
      const result: McpTestResult = data.success
        ? {
            success: true,
            toolCount: data.toolCount ?? 0,
            toolNames: data.toolNames ?? [],
          }
        : {
            success: false,
            toolCount: 0,
            toolNames: [],
            error: data.error || 'Connection failed',
            status: data.status ?? null,
            statusText: data.statusText ?? null,
            errorCode: data.errorCode ?? null,
            wwwAuthenticate: data.wwwAuthenticate ?? null,
            errorBody: data.errorBody ?? null,
          };

      if (isCurrent()) {
        setTestResults((prev) => ({ ...prev, [server.id]: { result, testedAt: new Date() } }));
      }
    } catch (err) {
      if (!isCurrent()) return;
      setTestResults((prev) => ({
        ...prev,
        [server.id]: {
          result: {
            success: false,
            toolCount: 0,
            toolNames: [],
            error: err instanceof Error ? err.message : 'Connection failed',
          },
          testedAt: new Date(),
        },
      }));
    } finally {
      setTestingId(null);
    }
  }

  // OAuth connect state
  const [oauthConnectingId, setOauthConnectingId] = useState<string | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // Clean up poll interval on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  // Close popup window after OAuth completes — only if this window
  // was opened programmatically (window.opener is set), so we don't
  // accidentally close the main admin page if someone navigates here
  // with a stale ?oauth= param from a bookmark or shared link.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthResult = params.get('oauth');
    if ((oauthResult === 'success' || oauthResult === 'error') && window.opener) {
      window.close();
    }
  }, []);

  async function handleOAuthConnect(server: { id: string; name: string }) {
    // Clear any existing poll interval before starting a new one
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setOauthConnectingId(server.id);

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const redirectUrl = window.location.href.split('?')[0].split('#')[0];
      const response = await authenticatedFetch(
        `/api/bots/${botId}/mcp-servers/${server.id}/oauth/start?redirectUrl=${encodeURIComponent(redirectUrl)}`,
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to start OAuth connection');
      }

      const data = await response.json();
      const authorizeUrl = data.authorizeUrl;

      // Open OAuth popup
      const popup = window.open(authorizeUrl, 'oauth-popup', 'width=600,height=700');
      if (!popup) {
        throw new Error('Popup blocked. Please allow popups for this site.');
      }

      // Poll for popup close
      pollRef.current = setInterval(async () => {
        try {
          if (popup.closed) {
            if (pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
            setOauthConnectingId(null);
            // A test run before the reconnect describes the old authorization. Drop it so
            // the row is shown from the reloaded state, not a stale live result (#193 review).
            // A test still in flight is from before the reconnect too, so its result is
            // discarded when it lands.
            testGenerationRef.current[server.id] = (testGenerationRef.current[server.id] ?? 0) + 1;
            setTestResults((prev) => {
              const next = { ...prev };
              delete next[server.id];
              return next;
            });
            await fetchServers();
          }
        } catch {
          // Cross-origin errors during redirect
        }
      }, 500);
    } catch (err) {
      console.error('OAuth connection error:', err);
      setOauthConnectingId(null);
    }
  }

  if (!authChecked || (loading && servers.length === 0)) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4 p-6">
        <Button variant="ghost" onClick={() => router.back()}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </Button>
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => router.back()}>
            <ArrowLeft className="mr-2 h-4 w-4" /> Back
          </Button>
          <div>
            <h1 className="text-2xl font-bold">MCP Servers</h1>
            <p className="text-muted-foreground text-sm">
              Manage MCP (Model Context Protocol) servers for this bot
            </p>
          </div>
        </div>

        <Dialog open={addDialogOpen} onOpenChange={handleAddDialogOpenChange}>
          <DialogTrigger asChild>
            <Button disabled={servers.length >= 5}>
              <Plus className="mr-2 h-4 w-4" /> Add Server
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>Add MCP Server</DialogTitle>
              <DialogDescription>
                Connect an external MCP server to this bot.
              </DialogDescription>
            </DialogHeader>

            {formError && (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}

            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="name">Server Name</Label>
                <Input
                  id="name"
                  placeholder="My MCP Server"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="serverUrl">Server URL</Label>
                <Input
                  id="serverUrl"
                  placeholder="https://example.com/mcp"
                  value={formData.serverUrl}
                  onChange={(e) => setFormData({ ...formData, serverUrl: e.target.value })}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="authType">Authentication Type</Label>
                <Select
                  value={formData.authType}
                  onValueChange={(value) => setFormData({ ...formData, authType: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select auth type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="bearer">Bearer Token</SelectItem>
                    <SelectItem value="api-key">API Key</SelectItem>
                    <SelectItem value="oauth">OAuth (Connect)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {formData.authType !== 'none' && formData.authType !== 'oauth' && (
                <div className="grid gap-2">
                  <Label htmlFor="authConfig">
                    {formData.authType === 'bearer' ? 'Bearer Token' : 'API Key'}
                  </Label>
                  <Input
                    id="authConfig"
                    type="password"
                    placeholder={
                      formData.authType === 'bearer' ? 'Enter bearer token' : 'Enter API key'
                    }
                    value={formData.authConfig}
                    onChange={(e) => setFormData({ ...formData, authConfig: e.target.value })}
                  />
                </div>
              )}

              {formData.authType === 'oauth' && (
                <>
                  {oauthDiscovery === 'discovering' && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Discovering OAuth endpoints...
                    </div>
                  )}

                  {oauthDiscovery === 'discovered' && discoveryRegistration === 'auto' && (
                    <>
                      <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 py-1">
                        <span className="h-2 w-2 rounded-full bg-emerald-500" />
                        Auto-configured
                        <span className="text-muted-foreground">— OAuth and credentials auto-discovered</span>
                      </div>

                      <div className="grid gap-2">
                        <Label htmlFor="oauthScopes">Scopes (optional)</Label>
                        <Input
                          id="oauthScopes"
                          placeholder="read write"
                          value={formData.oauthScopes || ''}
                          onChange={(e) => setFormData({ ...formData, oauthScopes: e.target.value })}
                        />
                      </div>
                    </>
                  )}

                  {oauthDiscovery === 'discovered' && discoveryRegistration === 'manual' && (
                    <>
                      <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 py-1">
                        <span className="h-2 w-2 rounded-full bg-emerald-500" />
                        Endpoints discovered
                        <span className="text-muted-foreground">— provide client credentials from your provider</span>
                      </div>

                      <div className="grid gap-2">
                        <Label htmlFor="oauthClientId">Client ID</Label>
                        <Input
                          id="oauthClientId"
                          placeholder="Client ID from the OAuth provider"
                          value={formData.oauthClientId || ''}
                          onChange={(e) => setFormData({ ...formData, oauthClientId: e.target.value })}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="oauthClientSecret">Client Secret</Label>
                        <Input
                          id="oauthClientSecret"
                          type="password"
                          placeholder="Client secret from the OAuth provider"
                          value={formData.oauthClientSecret || ''}
                          onChange={(e) => setFormData({ ...formData, oauthClientSecret: e.target.value })}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="oauthScopes">Scopes (optional)</Label>
                        <Input
                          id="oauthScopes"
                          placeholder="read write"
                          value={formData.oauthScopes || ''}
                          onChange={(e) => setFormData({ ...formData, oauthScopes: e.target.value })}
                        />
                      </div>
                    </>
                  )}

                  {oauthDiscovery === 'not_found' && (
                    <>
                      <p className="text-sm text-muted-foreground py-1">
                        Could not auto-discover OAuth endpoints. Enter the details from your provider manually.
                      </p>
                      <div className="grid gap-2">
                        <Label htmlFor="oauthAuthorizeUrl">Authorize URL</Label>
                        <Input
                          id="oauthAuthorizeUrl"
                          placeholder="https://app.provider.com/oauth/authorize"
                          value={formData.oauthAuthorizeUrl || ''}
                          onChange={(e) => setFormData({ ...formData, oauthAuthorizeUrl: e.target.value })}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="oauthTokenUrl">Token URL</Label>
                        <Input
                          id="oauthTokenUrl"
                          placeholder="https://app.provider.com/oauth/token"
                          value={formData.oauthTokenUrl || ''}
                          onChange={(e) => setFormData({ ...formData, oauthTokenUrl: e.target.value })}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="oauthClientId">Client ID</Label>
                        <Input
                          id="oauthClientId"
                          placeholder="Client ID from the OAuth provider"
                          value={formData.oauthClientId || ''}
                          onChange={(e) => setFormData({ ...formData, oauthClientId: e.target.value })}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="oauthClientSecret">Client Secret</Label>
                        <Input
                          id="oauthClientSecret"
                          type="password"
                          placeholder="Client secret from the OAuth provider"
                          value={formData.oauthClientSecret || ''}
                          onChange={(e) => setFormData({ ...formData, oauthClientSecret: e.target.value })}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="oauthScopes">Scopes (optional)</Label>
                        <Input
                          id="oauthScopes"
                          placeholder="read write"
                          value={formData.oauthScopes || ''}
                          onChange={(e) => setFormData({ ...formData, oauthScopes: e.target.value })}
                        />
                      </div>
                    </>
                  )}
                </>
              )}

              {/* Extra Headers */}
              <div className="grid gap-2">
                <Label>Extra Headers</Label>
                {formData.headers.map((header, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Input
                      placeholder="Header name"
                      value={header.key}
                      onChange={(e) => {
                        const newHeaders = [...formData.headers];
                        newHeaders[index] = { ...newHeaders[index], key: e.target.value };
                        setFormData({ ...formData, headers: newHeaders });
                      }}
                      className="flex-1"
                    />
                    <Input
                      placeholder="Value"
                      type="password"
                      value={header.value}
                      onChange={(e) => {
                        const newHeaders = [...formData.headers];
                        newHeaders[index] = { ...newHeaders[index], value: e.target.value };
                        setFormData({ ...formData, headers: newHeaders });
                      }}
                      className="flex-1"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove header"
                      onClick={() => {
                        setFormData({
                          ...formData,
                          headers: formData.headers.filter((_, i) => i !== index),
                        });
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setFormData({
                      ...formData,
                      headers: [...formData.headers, { key: '', value: '' }],
                    });
                  }}
                  className="w-fit"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Add Header
                </Button>
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  id="enabled"
                  checked={formData.enabled}
                  onCheckedChange={(checked) => setFormData({ ...formData, enabled: checked })}
                />
                <Label htmlFor="enabled">Enabled on creation</Label>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => handleAddDialogOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={submitting || oauthDiscovery === 'discovering' || (formData.authType === 'oauth' && oauthDiscovery === 'idle') || !formData.name || !formData.serverUrl}>
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Add Server
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Server count badge */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Server className="h-4 w-4" />
        <span>
          {servers.length} / 5 MCP servers configured
        </span>
      </div>

      {/* Server list */}
      {servers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Server className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground text-lg font-medium mb-1">No MCP servers configured</p>
            <p className="text-muted-foreground text-sm mb-4">
              Add an MCP server to extend this bot with custom tools and capabilities.
            </p>
            <Button onClick={() => setAddDialogOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> Add Your First Server
              </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead>Auth</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Tools</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {servers.map((server) => (
                  <TableRow key={server.id}>
                    <TableCell className="font-medium">{server.name}</TableCell>
                    <TableCell className="max-w-[200px] truncate">
                      <a
                        href={server.serverUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-blue-500 hover:underline"
                      >
                        {server.serverUrl}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </TableCell>
                    <TableCell>
                      <Badge variant={server.authType === 'none' ? 'secondary' : 'outline'}>
                        {server.authType}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Switch
                          aria-label={`Toggle ${server.name} enabled`}
                          checked={server.enabled}
                          onCheckedChange={() => handleToggle(server)}
                        />
                        <span className="text-sm">
                          {server.enabled ? (
                            <span className="flex items-center gap-1 text-green-600">
                              <Wifi className="h-3 w-3" /> Enabled
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-muted-foreground">
                              <WifiOff className="h-3 w-3" /> Disabled
                            </span>
                          )}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {testingId === server.id ? (
                        <span className="text-xs text-muted-foreground">Testing…</span>
                      ) : (
                        (() => {
                          const live = testResults[server.id];
                          const summary = summarizeTestResult(
                            live ? live.result : server.lastTestResult,
                            {
                              testedAt: live ? live.testedAt : server.lastTestedAt,
                              // A stored result is judged against the connection's token state:
                              // an expired but renewable token is flagged without a re-authorize
                              // prompt, and a recorded verdict (which clears the expiry) is never
                              // shown as green. A test run just now is newer than that state,
                              // which is not reloaded after a test (a test can renew the token),
                              // so it is shown as it came back.
                              oauthExpiresAt: live ? null : server.oauthExpiresAt,
                              reconnectRequired: live ? undefined : server.oauthReconnectRequired,
                            }
                          );
                          // A live success names the tools inline; a stored one does not.
                          const detail =
                            live && live.result.success && live.result.toolNames.length > 0
                              ? `${summary.detail ?? `tested ${'just now'}`} · ${live.result.toolNames.join(', ')}`
                              : summary.detail;
                          const toneClass =
                            summary.tone === 'ok'
                              ? 'text-green-600'
                              : summary.tone === 'stale'
                                ? 'text-amber-600'
                                : summary.tone === 'error'
                                  ? 'text-red-600'
                                  : 'text-muted-foreground';
                          return (
                            <div className="flex flex-col gap-0.5">
                              <span className={`text-xs ${toneClass}`} title={detail}>
                                {summary.label}
                              </span>
                              {detail && (
                                <span
                                  className="text-[10px] text-muted-foreground break-all"
                                  title={detail}
                                >
                                  {detail}
                                </span>
                              )}
                            </div>
                          );
                        })()
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleTestConnection(server)}
                          disabled={testingId === server.id}
                        >
                          {testingId === server.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <TestTube className="h-3 w-3" />
                          )}
                          <span className="ml-1">Test</span>
                        </Button>

                        {server.authType === 'oauth' && !server.oauthConnected && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleOAuthConnect(server)}
                            disabled={oauthConnectingId === server.id}
                          >
                            {oauthConnectingId === server.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <span className="text-xs">
                                {server.oauthReconnectRequired ? 'Reconnect' : 'Connect with OAuth'}
                              </span>
                            )}
                          </Button>
                        )}

                        {server.authType === 'oauth' && server.oauthReconnectRequired && server.oauthReconnectReason && (
                          <span
                            className="max-w-[240px] text-[10px] text-amber-600"
                            title={server.oauthReconnectReason}
                          >
                            {server.oauthReconnectReason}
                          </span>
                        )}

                        {server.authType === 'oauth' && server.oauthConnected && (
                          <span className="inline-flex items-center gap-1 px-2 py-1 text-xs text-green-400 bg-green-500/10 rounded font-semibold">
                            Connected ✓
                          </span>
                        )}

                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="destructive"
                              size="sm"
                              aria-label={`Delete ${server.name}`}
                              onClick={() => setDeleteServerId(server.id)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete MCP Server</AlertDialogTitle>
                              <AlertDialogDescription>
                                Are you sure you want to delete &ldquo;{server.name}&rdquo;? This action cannot be
                                undone. The bot will lose access to this MCP server&rsquo;s tools.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel onClick={() => setDeleteServerId(null)}>
                                Cancel
                              </AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                onClick={handleDelete}
                              >
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
