import { NextRequest } from 'next/server';
import { validateServiceToken } from '@/lib/service-tokens';

const asking = (authorization?: string) => new NextRequest('http://localhost/x', { headers: authorization ? { authorization } : {} });

describe('the shared service token', () => {
  const before = process.env.BOT_SERVICE_TOKEN;
  afterEach(() => {
    if (before === undefined) delete process.env.BOT_SERVICE_TOKEN;
    else process.env.BOT_SERVICE_TOKEN = before;
  });

  it('takes the exact token and nothing else, whatever its length', () => {
    process.env.BOT_SERVICE_TOKEN = 'service-secret-1234';
    expect(validateServiceToken(asking('Bearer service-secret-1234'))).toBe(true);
    expect(validateServiceToken(asking('Bearer service-secret-1235'))).toBe(false);
    expect(validateServiceToken(asking('Bearer service-secret'))).toBe(false);
    expect(validateServiceToken(asking('Bearer service-secret-1234-and-more'))).toBe(false);
    expect(validateServiceToken(asking('Basic service-secret-1234'))).toBe(false);
    expect(validateServiceToken(asking())).toBe(false);
  });

  it('takes nothing while no token is set', () => {
    delete process.env.BOT_SERVICE_TOKEN;
    expect(validateServiceToken(asking('Bearer '))).toBe(false);
    expect(validateServiceToken(asking('Bearer anything'))).toBe(false);
  });
});
