/**
 * Authentication Helper
 * Utilities for authentication in integration tests
 */

import { getTestConfig } from '../config';

export interface LoginResponse {
  user: {
    id: string;
    uuid: string;
    email: string | null;
    name: string | null;
    tags: string[];
  };
}

/**
 * Login to admin interface with OIDC token
 */
export async function loginToAdmin(accessToken: string): Promise<LoginResponse> {
  const config = getTestConfig();

  const response = await fetch(`${config.adminApiUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ accessToken }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Login failed: ${error.error || response.statusText}`);
  }

  return response.json();
}

/**
 * Get current user from session
 */
export async function getCurrentUser(cookies: string): Promise<LoginResponse> {
  const config = getTestConfig();

  const response = await fetch(`${config.adminApiUrl}/api/auth/me`, {
    headers: {
      Cookie: cookies,
    },
  });

  if (!response.ok) {
    throw new Error(`Get user failed: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Logout from admin interface
 */
export async function logoutFromAdmin(cookies: string): Promise<void> {
  const config = getTestConfig();

  await fetch(`${config.adminApiUrl}/api/auth/logout`, {
    method: 'POST',
    headers: {
      Cookie: cookies,
    },
  });
}

