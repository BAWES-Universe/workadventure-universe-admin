import { prisma } from '@/lib/db';
import { ownsBrick } from '@/lib/brick';

/**
 * Who may act on one computer job from the person's side (computers full plan, piece 2): the Brick's owner, and only for a job of THAT Brick. A job id
 * alone is never enough. The same rule as `brickOf` in lib/computer.ts, kept here so the notes, Activity and the Brick's door do not import the whole
 * computer module (which imports them).
 */
export async function ownersJob(botId: string, ownerId: string, jobId: string): Promise<{ id: string; botId: string; title: string; status: string } | null> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true, roomId: true, ownerId: true, deletedAt: true } });
  if (!bot || !ownsBrick(bot, ownerId)) return null;
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { id: true, botId: true, title: true, status: true } });
  return job && job.botId === botId ? job : null;
}
