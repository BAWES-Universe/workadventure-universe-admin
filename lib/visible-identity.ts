/**
 * The player id stored with a bot's conversation or memory is the player's email when they signed in with one. People
 * who may not see emails get the player's uuid instead (or nothing when the player is not known), so the email does
 * not come back through this field.
 */
export function visibleUserUuid(
  userUuid: string | null | undefined,
  canSeeEmails: boolean,
  knownUuid?: string | null,
): string | null {
  if (!userUuid) return null;
  if (canSeeEmails || !userUuid.includes('@')) return userUuid;
  return knownUuid ?? null;
}
