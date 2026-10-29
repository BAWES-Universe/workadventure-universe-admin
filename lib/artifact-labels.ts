import type { ArtifactKind } from '@/lib/artifacts';

/** The badge the game draws on a card, in the same words and colours, so a shared link looks like what people saw in the chat. */
export function artifactKindLabel(kind: ArtifactKind): { badge: string; color: string } {
  switch (kind) {
    case 'app':
      return { badge: 'APP', color: '#7c3aed' };
    case 'page':
      return { badge: 'PAGE', color: '#2563eb' };
    case 'markdown':
      return { badge: 'DOC', color: '#0f766e' };
    case 'svg':
      return { badge: 'SVG', color: '#be185d' };
  }
}

/** "Mini app", "Page"...: what the game's card says the artifact is, in the same words. */
export function artifactKindName(kind: ArtifactKind): string {
  switch (kind) {
    case 'app':
      return 'Mini app';
    case 'page':
      return 'Page';
    case 'markdown':
      return 'Document';
    case 'svg':
      return 'Drawing';
  }
}
