'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { useRouter } from 'next/navigation';
import SpriteSheetPreview from '@/components/sprite-preview';

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
  /** Called when delete is clicked */
  onDelete: (id: string) => void;
  /** Navigation base path (e.g. /admin/avatars/${setId}/layers/) — card click goes there */
  detailBasePath?: string;
}

/**
 * A card showing an animated sprite preview of a texture with name, position, and actions.
 * Clicking the card navigates to the detail page (if detailBasePath is provided).
 * Name is editable via double-click (inline edit with auto-save on blur).
 * Delete shows a confirm() dialog before proceeding.
 */
export default function TextureCard({
  texture,
  playServiceUrl = typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_PLAY_URL : undefined,
  onRename,
  onDelete,
  detailBasePath,
}: TextureCardProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(texture.name || texture.textureId);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (editName === (texture.name || texture.textureId)) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onRename(texture.id, editName);
    } catch {
      setEditName(texture.name || texture.textureId);
    }
    setSaving(false);
    setEditing(false);
  }

  function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    if (confirm(`Delete "${texture.name || texture.textureId}"? This cannot be undone.`)) {
      onDelete(texture.id);
    }
  }

  function handleClick() {
    if (!detailBasePath) return;
    router.push(`${detailBasePath}/${texture.id}`);
  }

  return (
    <div
      className={`group relative flex flex-col items-center gap-1.5 rounded-lg border border-border/40 p-2 hover:border-primary/30 transition-colors ${
        detailBasePath ? 'cursor-pointer' : ''
      }`}
      onClick={handleClick}
    >
      {/* Animated sprite preview */}
      <div className="w-[72px] h-[96px] bg-muted/20 rounded flex items-center justify-center overflow-hidden">
        {texture.url ? (
          <SpriteSheetPreview url={texture.url} playServiceUrl={playServiceUrl} animate />
        ) : null}
      </div>

      {/* Texture ID (always visible, small) */}
      <span className="text-[9px] text-muted-foreground font-mono truncate w-full text-center">
        {texture.textureId}
      </span>

      {/* Editable name */}
      {editing ? (
        <Input
          className="h-6 text-[10px] text-center"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave();
            if (e.key === 'Escape') { setEditName(texture.name || texture.textureId); setEditing(false); }
          }}
          disabled={saving}
          autoFocus
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className="text-[10px] text-center leading-tight cursor-pointer hover:text-primary truncate w-full"
          onDoubleClick={(e) => { e.stopPropagation(); setEditName(texture.name || texture.textureId); setEditing(true); }}
          title={`${texture.textureId} — double-click to rename`}
        >
          {texture.name || texture.textureId}
        </span>
      )}

      {/* Meta row */}
      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
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