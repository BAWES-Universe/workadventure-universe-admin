/** Where the provider sends the person back to: only this site or an allowed origin, else the apps page. Never an open redirect. */
export function safeReturnUrl(request: Request, asked: unknown, fallbackPath = '/admin/apps'): string {
  const requestOrigin = new URL(request.url).origin;
  const allowed = [requestOrigin, ...(process.env.CORS_ALLOWED_ORIGINS || '').split(',').filter(Boolean)];
  if (typeof asked === 'string' && asked) {
    try {
      if (allowed.includes(new URL(asked).origin)) return asked;
    } catch {
      // fall through
    }
  }
  return `${process.env.CORS_ALLOWED_ORIGINS?.split(',')[0] || requestOrigin}${fallbackPath}`;
}
