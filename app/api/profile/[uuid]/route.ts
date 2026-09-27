import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

async function getProfileData(uuid: string) {
  const user = await prisma.user.findUnique({
    where: { uuid },
    select: { id: true, name: true },
  });
  
  if (!user) {
    return null;
  }
  
  const visitCard = await (prisma as any).visitCard.findUnique({
    where: { userId: user.id },
    select: { bio: true, links: true },
  });
  
  if (!visitCard) {
    return null;
  }
  
  return {
    name: user.name ?? undefined,
    bio: visitCard.bio ?? undefined,
    // Web links only, so an old javascript: or data: address never runs for whoever opens the profile.
    links: ((visitCard.links || []) as Array<{ label: string; url: string }>).filter((link) => /^https?:\/\//i.test(link.url)),
  };
}

function escapeHtml(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const LINK_ICON = `<svg class="link-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>`;

/**
 * Someone's profile: their words and links. Embedded (the game's card under their avatar and name), it sits straight
 * on the game's dark panel with no name of its own and no page colour: it declares a dark scheme, as the panel is,
 * so the browser never paints the frame white behind it. On its own it is a small dark page with the name.
 */
function renderHTML(data: { name?: string; bio?: string; links: Array<{ label: string; url: string }> }, isEmbedded: boolean) {
  const name = escapeHtml(data.name);
  const bio = escapeHtml(data.bio);
  const links = data.links ?? [];
  const empty = !data.bio && links.length === 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="color-scheme" content="dark"/>
  <title>${name || 'Profile'}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root { color-scheme: dark; }
    html, body { background: ${isEmbedded ? 'transparent' : '#0f172a'}; }
    body { font-family: Inter, system-ui, -apple-system, 'Segoe UI', sans-serif; color: #fff; -webkit-font-smoothing: antialiased; }
    .profile { display: grid; gap: 14px; ${isEmbedded ? 'padding: 4px 16px 18px;' : 'max-width: 28rem; margin: 0 auto; padding: 32px 20px;'} }
    h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
    .bio { font-size: 15px; line-height: 1.5; color: rgb(255 255 255 / 0.82); white-space: pre-wrap; overflow-wrap: anywhere; ${isEmbedded ? 'text-align: center;' : ''} }
    .links { display: grid; gap: 8px; }
    .links-title { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: rgb(255 255 255 / 0.55); }
    .link-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; padding: 10px 14px; border-radius: 12px; background: rgb(255 255 255 / 0.08); border: 1px solid rgb(255 255 255 / 0.1); color: #fff; text-decoration: none; font-size: 15px; font-weight: 500; transition: background 160ms, border-color 160ms; }
    .link-item:hover { background: rgb(255 255 255 / 0.14); border-color: rgb(255 255 255 / 0.18); }
    .link-item:focus-visible { outline: 2px solid #8b5cf6; outline-offset: 2px; }
    .link-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .link-icon { flex: none; width: 16px; height: 16px; color: rgb(255 255 255 / 0.6); }
    .empty { font-size: 14px; color: rgb(255 255 255 / 0.55); text-align: center; }
    @media (prefers-reduced-motion: reduce) { .link-item { transition: none; } }
  </style>
  ${isEmbedded ? `
  <script>
    function notifySize() {
      if (!document.body) return;
      const height = document.body.scrollHeight;
      const width = document.body.scrollWidth;
      window.parent.postMessage({ type: 'cvIframeSize', data: { h: height, w: width } }, '*');
    }

    function initResizeObserver() {
      if (!document.body) {
        // Wait for body to be available
        setTimeout(initResizeObserver, 10);
        return;
      }

      try {
        const observer = new ResizeObserver(notifySize);
        observer.observe(document.body);
        notifySize(); // Initial size notification
      } catch (error) {
        console.error('ResizeObserver error:', error);
        // Fallback: just notify on load
        window.addEventListener('load', notifySize);
        setTimeout(notifySize, 100);
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initResizeObserver);
    } else {
      initResizeObserver();
    }

    window.addEventListener('load', notifySize);
  </script>
  ` : ''}
</head>
<body>
  <main class="profile">
    ${!isEmbedded && name ? `<h1>${name}</h1>` : ''}
    ${bio ? `<p class="bio">${bio}</p>` : ''}
    ${links.length > 0 ? `
      <nav class="links" aria-label="Links">
        ${isEmbedded ? '' : '<p class="links-title">Links</p>'}
        ${links.map((link) => `
          <a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" class="link-item">
            <span class="link-label">${escapeHtml(link.label)}</span>
            ${LINK_ICON}
          </a>
        `).join('')}
      </nav>
    ` : ''}
    ${empty ? '<p class="empty">No profile yet.</p>' : ''}
  </main>
</body>
</html>`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ uuid: string }> }
) {
  const { uuid: uuidRaw } = await params;
  const uuid = decodeURIComponent(uuidRaw);
  
  const data = await getProfileData(uuid);
  
  if (!data) {
    const accept = request.headers.get('accept') || '';
    if (accept.includes('text/html')) {
      return new NextResponse(
        `<!DOCTYPE html><html><head><title>Not Found</title></head><body><h1>Profile not found</h1></body></html>`,
        { status: 404, headers: { 'Content-Type': 'text/html' } }
      );
    }
    return NextResponse.json({ error: 'Visit card not found' }, { status: 404 });
  }
  
  // Check if client wants HTML (browser request) or JSON (API request)
  const accept = request.headers.get('accept') || '';
  const searchParams = request.nextUrl.searchParams;
  const isEmbedded = searchParams.get('embed') === 'true';
  
  // Serve HTML if Accept header includes text/html or if it's a direct browser request
  if (accept.includes('text/html') || (!accept.includes('application/json') && !request.headers.get('x-requested-with'))) {
    // Create response with CSP for iframe embedding
    // Note: We cannot remove X-Frame-Options here because Next.js config headers are applied AFTER route handlers
    // The config rule /api/:path* sets DENY, which will override our deletion.
    // Instead, we rely on the more specific /api/profile/:path* config rule to set SAMEORIGIN,
    // and the CSP frame-ancestors directive for cross-origin support.
    const response = new NextResponse(renderHTML(data, isEmbedded), {
      headers: { 
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "frame-ancestors 'self' http://play.workadventure.localhost https://play.workadventure.localhost http://play.bawes.localhost https://play.bawes.localhost http://play.bawes.net https://play.bawes.net *;",
      },
    });
    return response;
  }
  
  // Otherwise serve JSON
  return NextResponse.json(data);
}
