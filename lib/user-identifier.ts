import { prisma } from '@/lib/db';

/** A user as the game names them: their WorkAdventure uuid, or their email for signed-in players. */
export function findUserByIdentifier(identifier: string) {
  return prisma.user.findFirst({ where: { OR: [{ uuid: identifier }, { email: identifier }] } });
}
