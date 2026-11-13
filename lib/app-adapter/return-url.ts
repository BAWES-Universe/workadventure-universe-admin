/** Where the provider sends the person back to: only this site or an allowed origin, else the apps page. Never an open redirect. */
export function safeReturnUrl(request: Request, asked: unknown, fallbackPath = '/admin/apps'): string {
  const requestOrigin = new URL(request.url).origin;
  // Trimmed entry by entry, the same as the CORS list, so "https://a.test, https://b.test" works
  const configured = (process.env.CORS_ALLOWED_ORIGINS || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const allowed = [requestOrigin, ...configured];
  if (typeof asked === 'string' && asked) {
    try {
      if (allowed.includes(new URL(asked).origin)) return asked;
    } catch {
      // fall through
    }
  }
  return `${configured[0] || requestOrigin}${fallbackPath}`;
}
