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
    name: user.name,
    bio: visitCard.bio,
    links: visitCard.links || [],
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

function renderHTML(data: { name?: string; bio?: string; links: Array<{ label: string; url: string }> }, isEmbedded: boolean) {
  const name = escapeHtml(data.name);
  const bio = escapeHtml(data.bio);
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${name || 'Visit Card'}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: ${isEmbedded ? 'transparent' : '#111827'}; color: white; }
    .container { min-height: 100vh; padding: 1.5rem; }
    .card { max-width: 28rem; margin: 0 auto; background: #1f2937; border-radius: 0.5rem; padding: 1.5rem; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1); }
    h1 { font-size: 1.5rem; font-weight: bold; margin-bottom: 1rem; }
    .bio { margin-bottom: 1.5rem; color: #d1d5db; white-space: pre-wrap; }
    .links { margin-top: 1.5rem; }
    .links-title { font-size: 0.875rem; font-weight: 600; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; }
    .link-item { display: block; width: 100%; background: #374151; border-radius: 0.5rem; padding: 0.75rem 1rem; margin-bottom: 0.75rem; transition: background 0.2s; text-decoration: none; color: white; }
    .link-item:hover { background: #4b5563; }
    .link-content { display: flex; align-items: center; justify-content: space-between; }
    .link-label { font-weight: 500; }
    .link-icon { width: 1rem; height: 1rem; color: #9ca3af; }
    .empty { color: #6b7280; text-align: center; padding: 2rem 0; }
    .loading, .error { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  </style>
  ${isEmbedded ? `
  <script>
    function notifySize() {
      const height = document.body.scrollHeight;
      const width = document.body.scrollWidth;
      window.parent.postMessage({ type: 'cvIframeSize', data: { h: height, w: width } }, '*');
    }
    window.addEventListener('load', notifySize);
    new ResizeObserver(notifySize).observe(document.body);
    setTimeout(notifySize, 100);
  </script>
  ` : ''}
</head>
<body>
  <div class="container">
    <div class="card">
      ${name ? `<h1>${name}</h1>` : ''}
      ${bio ? `<div class="bio">${bio}</div>` : ''}
      ${data.links && data.links.length > 0 ? `
        <div class="links">
          <div class="links-title">Links</div>
          ${data.links.map(link => `
            <a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" class="link-item">
              <div class="link-content">
                <span class="link-label">${escapeHtml(link.label)}</span>
                <svg class="link-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
                </svg>
              </div>
            </a>
          `).join('')}
        </div>
      ` : ''}
      ${!data.bio && (!data.links || data.links.length === 0) ? `
        <div class="empty">This visit card is empty.</div>
      ` : ''}
    </div>
  </div>
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
        `<!DOCTYPE html><html><head><title>Not Found</title></head><body><h1>Visit card not found</h1></body></html>`,
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
    return new NextResponse(renderHTML(data, isEmbedded), {
      headers: { 
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'SAMEORIGIN', // Allow embedding in iframes from same origin
      },
    });
  }
  
  // Otherwise serve JSON
  return NextResponse.json(data);
}
