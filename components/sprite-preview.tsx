'use client';

/**
 * Sprite sheet preview component for WA textures.
 *
 * WA textures are 96×128 PNG spritesheets with 12 frames:
 *   3 columns × 4 rows, each frame 32×32px
 *   Rows: back → front → side → side
 *   Columns: walk cycle frames within each direction
 *
 * Props:
 *   - url: the texture URL (absolute or relative)
 *   - playServiceUrl: base URL for relative URLs
 *   - animate: if true, loops the first row (back walk cycle) as CSS animation
 *   - large: if true, shows entire sheet at larger size with frame grid labels
 */

interface SpriteSheetPreviewProps {
  url: string;
  playServiceUrl?: string;
  animate?: boolean;
  large?: boolean;
}

export default function SpriteSheetPreview({
  url,
  playServiceUrl,
  animate = false,
  large = false,
}: SpriteSheetPreviewProps) {
  // Resolve URL
  const resolvedUrl = url?.startsWith('http')
    ? url.split('?')[0]
    : playServiceUrl
      ? `${playServiceUrl.replace(/\/$/, '')}/${url}`
      : '';

  if (!resolvedUrl) return null;

  if (large) {
    // Full spritesheet view
    return (
      <div className="space-y-4">
        <div className="relative inline-block border-2 border-border rounded-lg overflow-hidden bg-muted/20">
          <img
            src={resolvedUrl}
            alt="Full spritesheet"
            className="w-48 h-64 object-contain"
            style={{ imageRendering: 'pixelated' }}
          />
          {/* Grid overlay showing frame divisions */}
          <svg
            className="absolute inset-0 pointer-events-none"
            width="100%"
            height="100%"
            viewBox="0 0 192 256"
          >
            <line x1="64" y1="0" x2="64" y2="256" stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
            <line x1="128" y1="0" x2="128" y2="256" stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
            <line x1="0" y1="64" x2="192" y2="64" stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
            <line x1="0" y1="128" x2="192" y2="128" stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
            <line x1="0" y1="192" x2="192" y2="192" stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
            <text x="96" y="30" textAnchor="middle" fill="rgba(255,255,255,0.6)" fontSize="10">Back</text>
            <text x="96" y="94" textAnchor="middle" fill="rgba(255,255,255,0.6)" fontSize="10">Front</text>
            <text x="96" y="158" textAnchor="middle" fill="rgba(255,255,255,0.6)" fontSize="10">Side</text>
            <text x="96" y="222" textAnchor="middle" fill="rgba(255,255,255,0.6)" fontSize="10">Side</text>
          </svg>
        </div>
        <p className="text-[10px] text-muted-foreground">
          96×128 px · 12 frames (3 cols × 4 rows) · 32×32 px each
        </p>
      </div>
    );
  }

  // Card preview — always spritesheet, animate first row if animate=true
  return (
    <>
      <div
        className={animate ? 'sprite-animated' : ''}
        style={{
          width: 32,
          height: 32,
          backgroundImage: `url('${resolvedUrl}')`,
          backgroundSize: '96px 128px',
          backgroundPosition: '0px 0px',
          imageRendering: 'pixelated',
        }}
      />
      {animate && (
        <style>{`
          .sprite-animated {
            animation: sprite-walk 0.6s steps(3) infinite;
          }
          @keyframes sprite-walk {
            from { background-position: 0px 0px; }
            to { background-position: -96px 0px; }
          }
        `}</style>
      )}
    </>
  );
}