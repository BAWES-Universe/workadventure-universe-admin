'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Layers } from 'lucide-react';

interface TextureItem {
  id: string;
  textureId: string;
  name: string | null;
  url: string;
  position: number;
  isActive: boolean;
}

interface TextureCardProps {
  texture: TextureItem;
  /** Base URL for the play service — prepended to relative texture URLs */
  playServiceUrl?: string;
  /** Called when name is edited inline (blur / Enter) */
  onRename: (id: string, name: string) => Promise<void>;
  /** Called when URL is edited inline (blur / Enter) */
  onUpdateUrl: (id: string, url: string) => Promise<void>;
  /** Called when delete is clicked (caller should confirm) */
  onDelete: (id: string) => void;
}

/**
 * A small card showing a texture thumbnail with editable name and URL,
 * position, active indicator, and a delete button.
 *
 * Name is editable via double-click (inline edit with auto-save on blur).
 * URL is editable via double-click on the URL badge.
 * Delete shows a confirm() dialog before proceeding.
 */
export default function TextureCard({
  texture,
  playServiceUrl = typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_PLAY_URL : undefined,
  onRename,
  onUpdateUrl,
  onDelete,
}: TextureCardProps) {
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState(texture.name || texture.textureId);
  const [editingUrl, setEditingUrl] = useState(false);
  const [editUrl, setEditUrl] = useState(texture.url);
  const [saving, setSaving] = useState(false);

  // Build the display URL: if relative, prepend playServiceUrl
  const displayUrl = texture.url?.startsWith('http')
    ? texture.url.split('?')[0]
    : playServiceUrl
      ? `${playServiceUrl.replace(/\/$/, '')}/${texture.url}`
      : '';

  async function handleSaveName() {
    if (editName === (texture.name || texture.textureId)) {
      setEditingName(false);
      return;
    }
    setSaving(true);
    try {
      await onRename(texture.id, editName);
    } catch {
      setEditName(texture.name || texture.textureId);
    }
    setSaving(false);
    setEditingName(false);
  }

  async function handleSaveUrl() {
    if (editUrl === texture.url) {
      setEditingUrl(false);
      return;
    }
    setSaving(true);
    try {
      await onUpdateUrl(texture.id, editUrl);
    } catch {
      setEditUrl(texture.url);
    }
    setSaving(false);
    setEditingUrl(false);
  }

  function handleDelete() {
    if (confirm(`Delete "${texture.name || texture.textureId}"? This cannot be undone.`)) {
      onDelete(texture.id);
    }
  }

  return (
    <div className="group relative flex flex-col items-center gap-1.5 rounded-lg border border-border/40 p-2 hover:border-primary/30 transition-colors">
      {/* Thumbnail */}
      <div className="w-[72px] h-[96px] bg-muted/20 rounded flex items-center justify-center overflow-hidden">
        {displayUrl ? (
          <img
            src={displayUrl}
            alt={texture.textureId}
            className="max-w-full max-h-full object-contain image-pixelated"
            loading="lazy"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
              const parent = (e.target as HTMLImageElement).parentElement;
              if (parent) {
                const fallback = document.createElement('div');
                fallback.className = 'flex items-center justify-center h-full';
                fallback.innerHTML = '<svg class="h-5 w-5 text-muted-foreground/40" stroke="currentColor" fill="none" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>';
                parent.appendChild(fallback);
              }
            }}
          />
        ) : (
          <Layers className="h-6 w-6 text-muted-foreground/30" />
        )}
      </div>

      {/* Texture ID (always visible, small) */}
      <span className="text-[9px] text-muted-foreground font-mono truncate w-full text-center">
        {texture.textureId}
      </span>

      {/* Editable name */}
      {editingName ? (
        <Input
          className="h-6 text-[10px] text-center"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleSaveName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSaveName();
            if (e.key === 'Escape') { setEditName(texture.name || texture.textureId); setEditingName(false); }
          }}
          disabled={saving}
          autoFocus
        />
      ) : (
        <span
          className="text-[10px] text-center leading-tight cursor-pointer hover:text-primary truncate w-full"
          onDoubleClick={() => { setEditName(texture.name || texture.textureId); setEditingName(true); }}
          title={`${texture.textureId} — double-click to rename`}
        >
          {texture.name || texture.textureId}
        </span>
      )}

      {/* Editable URL badge */}
      {editingUrl ? (
        <Input
          className="h-5 text-[8px] font-mono text-center"
          value={editUrl}
          onChange={(e) => setEditUrl(e.target.value)}
          onBlur={handleSaveUrl}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSaveUrl();
            if (e.key === 'Escape') { setEditUrl(texture.url); setEditingUrl(false); }
          }}
          disabled={saving}
          autoFocus
        />
      ) : (
        <span
          className="text-[8px] font-mono text-muted-foreground truncate w-full text-center cursor-pointer hover:text-primary"
          onDoubleClick={() => { setEditUrl(texture.url); setEditingUrl(true); }}
          title={`${texture.url} — double-click to edit URL`}
        >
          {texture.url.length > 30 ? texture.url.substring(0, 28) + '…' : texture.url}
        </span>
      )}

      {/* Meta row */}
      <div className="flex items-center gap-1.5">
        <span className="text-[9px] text-muted-foreground font-mono">#{texture.position}</span>
        <span className={`text-[9px] px-1 rounded ${texture.isActive ? 'text-emerald-500' : 'text-muted-foreground'}`}>
          {texture.isActive ? 'on' : 'off'}
        </span>
        <button
          className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-red-400 hover:text-red-500"
          onClick={handleDelete}
          title="Delete this texture"
        >
          ✕
        </button>
      </div>
    </div>
  );
}