import { safeReturnUrl } from '@/lib/app-adapter/return-url';

describe('safeReturnUrl', () => {
  const before = process.env.CORS_ALLOWED_ORIGINS;
  afterEach(() => {
    if (before === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = before;
  });
  const req = new Request('http://localhost:3000/api/me/apps/ready-made');

  it('allows an origin from a list written with spaces after the commas', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://play.example.test, https://other.example.test ,';
    expect(safeReturnUrl(req, 'https://other.example.test/x')).toBe('https://other.example.test/x');
    expect(safeReturnUrl(req, 'https://play.example.test/y')).toBe('https://play.example.test/y');
  });

  it('never sends the person to an origin that is not listed, and falls back to the first listed origin trimmed', () => {
    process.env.CORS_ALLOWED_ORIGINS = ' https://play.example.test , https://other.example.test';
    expect(safeReturnUrl(req, 'https://evil.test/x')).toBe('https://play.example.test/admin/apps');
  });

  it('falls back to this site when nothing is listed', () => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    expect(safeReturnUrl(req, 'https://evil.test/x')).toBe('http://localhost:3000/admin/apps');
  });
});
