/**
 * authenticateRequest: who the player is, from the OpenID access token the play server forwards. The play server
 * sends its admin token as configured, with or without "Bearer " in front; both must work.
 */
const fetchUserInfo = jest.fn();
jest.mock('openid-client', () => ({
  discovery: jest.fn(async () => ({})),
  ClientSecretPost: jest.fn(() => ({})),
  fetchUserInfo: (...args: unknown[]) => fetchUserInfo(...args),
  skipSubjectCheck: Symbol('skip'),
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));

import * as Sentry from '@sentry/nextjs';
import { authenticateRequest } from '@/lib/oidc';

const request = (authorization: string | null, accessToken: string | null = 'access-token') => {
  const url = `http://localhost/api/room/access?userIdentifier=p@example.test${accessToken ? `&accessToken=${accessToken}` : ''}`;
  return new Request(url, { headers: authorization ? { Authorization: authorization } : {} });
};

beforeAll(() => {
  process.env.ADMIN_API_TOKEN = 'admin-secret';
  process.env.OIDC_ISSUER = 'https://sso.test';
  process.env.OIDC_CLIENT_ID = 'id';
  process.env.OIDC_CLIENT_SECRET = 'secret';
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchUserInfo.mockResolvedValue({ sub: 'sub-1', email: 'p@example.test', name: 'Pat' });
});

describe('authenticateRequest', () => {
  it('knows a signed-in player when the admin token is sent bare', async () => {
    const user = await authenticateRequest(request('admin-secret'));
    expect(user).toMatchObject({ isAuthenticated: true, identifier: 'sub-1', email: 'p@example.test' });
  });

  it('knows a signed-in player when the admin token is sent with "Bearer "', async () => {
    const user = await authenticateRequest(request('Bearer admin-secret'));
    expect(user).toMatchObject({ isAuthenticated: true, identifier: 'sub-1' });
  });

  it('answers nobody, and says so, when the admin token is wrong or missing and a sign-in came with it', async () => {
    expect(await authenticateRequest(request('nope'))).toBeNull();
    expect(await authenticateRequest(request(null))).toBeNull();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
  });

  it('answers nobody, and does not report, when no sign-in came with a wrong admin token', async () => {
    expect(await authenticateRequest(request('nope', null))).toBeNull();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('is not signed in when the player sent no access token', async () => {
    expect(await authenticateRequest(request('admin-secret', null))).toMatchObject({ isAuthenticated: false });
  });
});
