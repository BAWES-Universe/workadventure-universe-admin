import type { AppConnection } from '@prisma/client';

/**
 * Only an app a person added with a link and a key, a token or nothing can be lent. One signed in as the person (a sign-in page,
 * a listed app, a ready-made app) stays theirs alone: lending it would let others act as them. The database holds the same line.
 */
export function isAppLendable(connection: Pick<AppConnection, 'ownerId' | 'source' | 'authType'>): boolean {
  return !!connection.ownerId && connection.source === 'link' && connection.authType !== 'oauth';
}
