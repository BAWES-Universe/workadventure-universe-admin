import { NextResponse } from 'next/server';

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** A small plain page for the one-time GitHub App setup (never seen by anyone but a super admin). */
export function setupPage(title: string, lines: string[], status = 200, extra = ''): NextResponse {
  const body = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>body{font:16px/1.5 system-ui,-apple-system,sans-serif;background:#0f1724;color:#e8ecf3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}main{max-width:480px}h1{font-size:22px;margin:0 0 12px}p{margin:0 0 10px;color:#c3cad6}button{font:inherit;font-weight:600;background:#4f7cff;color:#fff;border:0;border-radius:10px;padding:12px 18px;cursor:pointer}a{color:#8fb0ff}</style>
</head><body><main><h1>${escape(title)}</h1>${lines.map((line) => `<p>${escape(line)}</p>`).join('')}${extra}</main></body></html>`;
  return new NextResponse(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

export { escape as escapeHtml };
