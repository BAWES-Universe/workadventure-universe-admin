import type { Viewer } from '@/lib/access-scope';

/**
 * Whether the latest access record is the viewer's own: same user id or same user uuid. Decided on the server, before
 * the record is redacted, so the answer needs no visitor identity on the client. Only a signed-in user can be "you".
 */
export function viewerWasLast(
  viewer: Viewer | null,
  record: { userId?: string | null; userUuid?: string | null } | null | undefined,
): boolean {
  if (!record || viewer?.kind !== 'user') return false;
  return (
    (!!record.userId && record.userId === viewer.user.id) ||
    (!!record.userUuid && !!viewer.user.uuid && record.userUuid === viewer.user.uuid)
  );
}
