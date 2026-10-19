import { trustedCorsHeaders } from '@/lib/cors';

const requestFrom = (origin: string) => ({ headers: { get: (name: string) => (name.toLowerCase() === 'origin' ? origin : null) } });

describe('trustedCorsHeaders', () => {
  const saved = process.env.CORS_ALLOWED_ORIGINS;
  afterEach(() => {
    if (saved === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = saved;
  });

  it('allows a listed origin, even when the list has spaces after the commas', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://a.example, https://b.example ,';
    expect(trustedCorsHeaders(requestFrom('https://b.example'))['Access-Control-Allow-Origin']).toBe('https://b.example');
    expect(trustedCorsHeaders(requestFrom('https://a.example'))['Access-Control-Allow-Origin']).toBe('https://a.example');
  });

  it('gives no access to an origin that is not listed, or when nothing is listed', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://a.example';
    expect(trustedCorsHeaders(requestFrom('https://evil.example'))['Access-Control-Allow-Origin']).toBeUndefined();
    delete process.env.CORS_ALLOWED_ORIGINS;
    expect(trustedCorsHeaders(requestFrom('https://a.example'))['Access-Control-Allow-Origin']).toBeUndefined();
  });
});
