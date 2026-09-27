'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import Link from 'next/link';
import { Pencil, Trash2 } from 'lucide-react';
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
 * The whole card links to the detail page (if detailBasePath is provided); Rename and Delete sit above the link.
 * Rename edits the name inline and saves on blur or Enter. Delete asks with confirm() first.
 */
export default function TextureCard({
  texture,
  playServiceUrl = typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_PLAY_URL : undefined,
  onRename,
  onDelete,
  detailBasePath,
}: TextureCardProps) {
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

  function handleDelete() {
    if (confirm(`Delete "${texture.name || texture.textureId}"? This cannot be undone.`)) {
      onDelete(texture.id);
    }
  }

  const label = texture.name || texture.textureId;

  return (
    <div className="relative flex min-w-0 flex-col items-center gap-1.5 rounded-xl border border-border bg-card p-2 transition-colors hover:border-foreground/25 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring">
      {/* Animated sprite preview */}
      <div className="flex h-[96px] w-[72px] items-center justify-center overflow-hidden rounded bg-muted/20">
        {texture.url ? (
          <SpriteSheetPreview url={texture.url} playServiceUrl={playServiceUrl} animate />
        ) : null}
      </div>

      {/* Editable name; otherwise the name is the card's link */}
      {editing ? (
        <Input
          className="relative z-10 h-8 text-center text-xs"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave();
            if (e.key === 'Escape') { setEditName(label); setEditing(false); }
          }}
          disabled={saving}
          autoFocus
          aria-label="Name"
        />
      ) : detailBasePath ? (
        <Link
          href={`${detailBasePath}/${texture.id}`}
          className="w-full truncate text-center text-xs font-medium leading-tight outline-none after:absolute after:inset-0 after:rounded-xl after:content-['']"
          title={texture.textureId}
        >
          {label}
        </Link>
      ) : (
        <span className="w-full truncate text-center text-xs font-medium leading-tight" title={texture.textureId}>
          {label}
        </span>
      )}

      {/* Texture key (always visible, small) */}
      <span className="w-full truncate text-center font-mono text-[10px] text-muted-foreground">{texture.textureId}</span>

      {/* Meta and controls, kept above the card's link */}
      <div className="relative z-10 flex w-full items-center justify-between gap-1">
        <span className="font-mono text-[10px] text-muted-foreground">
          #{texture.position} · {texture.isActive ? 'on' : 'off'}
        </span>
        <span className="flex items-center">
          <button
            type="button"
            className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => { setEditName(label); setEditing(true); }}
            aria-label={`Rename ${label}`}
            title="Rename"
          >
            <Pencil size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive"
            onClick={handleDelete}
            aria-label={`Delete ${label}`}
            title="Delete"
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </span>
      </div>
    </div>
  );
}
