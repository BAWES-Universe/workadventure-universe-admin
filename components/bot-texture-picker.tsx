'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';

interface TextureItem {
  textureId: string;
  name: string | null;
}

interface AvatarSetForBot {
  id: string;
  name: string;
  layers: TextureItem[];
  companions: TextureItem[];
}

interface BotTexturePickerProps {
  botId: string;
  currentTextureId: string | null;
  onTextureChanged: () => void;
}

/**
 * Displays the bot's current texture and allows picking from the avatar catalog.
 * Fetches bot-assignable sets from the catalog API.
 */
export default function BotTexturePicker({ botId, currentTextureId, onTextureChanged }: BotTexturePickerProps) {
  const [textureSets, setTextureSets] = useState<AvatarSetForBot[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState(currentTextureId || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function loadTextures() {
      setLoading(true);
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const res = await authenticatedFetch('/api/admin/avatar-sets/bot-assignable');
        if (res.ok) {
          const data = await res.json();
          setTextureSets(data);
        }
      } catch {
        // Silently fail — texture picker won't show options
      }
      setLoading(false);
    }
    loadTextures();
  }, []);

  async function saveTexture() {
    setSaving(true);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      await authenticatedFetch(`/api/admin/bots/${botId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterTextureId: selected || null }),
      });
      setEditing(false);
      onTextureChanged();
    } catch {
      // Silently fail
    }
    setSaving(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Texture</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!editing ? (
          <div>
            <div className="text-sm font-medium text-muted-foreground">Current Texture</div>
            <div className="text-base mt-1">
              {currentTextureId ? (
                <Badge variant="secondary" className="text-xs font-mono">{currentTextureId}</Badge>
              ) : (
                <span className="text-muted-foreground italic">Default appearance</span>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-sm font-medium text-muted-foreground">Pick a texture</div>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : textureSets && textureSets.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                <Badge
                  variant={!selected ? 'default' : 'outline'}
                  className="cursor-pointer text-xs"
                  onClick={() => setSelected('')}
                >
                  Default
                </Badge>
                {textureSets.flatMap(set => [
                  ...(set.layers?.map(l => (
                    <Badge
                      key={`layer-${set.id}-${l.textureId}`}
                      variant={selected === l.textureId ? 'default' : 'outline'}
                      className="cursor-pointer text-xs hover:bg-accent"
                      onClick={() => setSelected(l.textureId)}
                    >
                      {set.name}: {l.name || l.textureId}
                    </Badge>
                  )) || []),
                  ...(set.companions?.map(c => (
                    <Badge
                      key={`comp-${set.id}-${c.textureId}`}
                      variant={selected === c.textureId ? 'default' : 'outline'}
                      className="cursor-pointer text-xs hover:bg-accent"
                      onClick={() => setSelected(c.textureId)}
                    >
                      {set.name}: {c.name || c.textureId}
                    </Badge>
                  )) || []),
                ])}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No catalog textures available. Create avatar sets with textures first.
              </p>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <Button size="sm" onClick={saveTexture} disabled={saving}>
                {saving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                Save
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setEditing(false); setSelected(currentTextureId || ''); }}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => { setEditing(true); setSelected(currentTextureId || ''); }}>
              Change Texture
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}