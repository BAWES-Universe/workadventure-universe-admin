'use client';

import { useState, useEffect, useCallback } from 'react';
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
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface McpServerFormData {
  name: string;
  serverUrl: string;
  authType: string;
  authConfig: string;
  enabled: boolean;
}

const emptyForm: McpServerFormData = {
  name: '',
  serverUrl: '',
  authType: 'none',
  authConfig: '',
  enabled: true,
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

  // Delete dialog state
  const [deleteServerId, setDeleteServerId] = useState<string | null>(null);

  // Test connection state
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({});

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
          authConfig: formData.authConfig || null,
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

      setAddDialogOpen(false);
      setFormData(emptyForm);
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

  async function handleTestConnection(server: McpServer) {
    setTestingId(server.id);
    setTestResults((prev) => ({ ...prev, [server.id]: { success: false, message: 'Testing...' } }));

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

      if (data.success) {
        setTestResults((prev) => ({
          ...prev,
          [server.id]: {
            success: true,
            message: `Connected — ${data.toolCount} tool${data.toolCount !== 1 ? 's' : ''} available${data.toolNames?.length ? ': ' + data.toolNames.join(', ') : ''}.`,
          },
        }));
      } else {
        setTestResults((prev) => ({
          ...prev,
          [server.id]: {
            success: false,
            message: data.error || 'Connection failed',
          },
        }));
      }
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [server.id]: {
          success: false,
          message: err instanceof Error ? err.message : 'Connection failed',
        },
      }));
    } finally {
      setTestingId(null);
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

        <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
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
                  </SelectContent>
                </Select>
              </div>

              {formData.authType !== 'none' && (
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
              <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={submitting || !formData.name || !formData.serverUrl}>
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
                      {testResults[server.id] ? (
                        <span
                          className={`text-xs ${
                            testResults[server.id].success
                              ? 'text-green-600'
                              : 'text-red-600'
                          }`}
                        >
                          {testResults[server.id].message}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">N/A</span>
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

                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => setDeleteServerId(server.id)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete MCP Server</AlertDialogTitle>
                              <AlertDialogDescription>
                                Are you sure you want to delete "{server.name}"? This action cannot be
                                undone. The bot will lose access to this MCP server's tools.
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
