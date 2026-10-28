import { config } from '@/middleware';

/** Which addresses run through the middleware: everything but static files and the artifact routes (#1510). */
const runs = (path: string) => config.matcher.some((pattern) => new RegExp(`^${pattern}$`).test(path));

describe('middleware matcher', () => {
  it('runs for pages and other API routes', () => {
    expect(runs('/admin')).toBe(true);
    expect(runs('/admin/ai-providers')).toBe(true);
    expect(runs('/api/me/ai-keys')).toBe(true);
    // A route whose name only starts the same way is not an artifact route
    expect(runs('/api/artifactsx')).toBe(true);
  });

  it('leaves out the artifact routes, whose bodies can be larger than a middleware lets through', () => {
    expect(runs('/api/artifacts')).toBe(false);
    expect(runs('/api/artifacts/abc/change')).toBe(false);
  });
});
