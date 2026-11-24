import { prisma } from '@/lib/db';
import { settingsOf } from '@/lib/mcp-tool-policy';

/**
 * A code job's reads are App tools Orbit runs for the Brick, so they must pass the same gate the bot server puts in front of every tool
 * (#738): the tool is one this Brick has on this connection, a person confirmed it, it sits under "Looks something up", and that heading is
 * set to run right away. A tool that is off, asks first, changes or sends, or that nobody confirmed (and every tool of an App that was
 * never checked) is never run for a job, because a job has nobody to ask. Returns the first tool that does not pass, or null.
 */
export async function firstReadNotAllowed(botId: string, connectionId: string | null, tools: readonly string[]): Promise<string | null> {
  if (tools.length === 0) return null;
  if (!connectionId) return tools[0];
  const server = await prisma.botMcpServer.findFirst({
    where: { botId, connectionId, enabled: true },
    select: { legacyText: true, lookUpSetting: true, makeSetting: true, changeSetting: true, deleteSendSetting: true, tools: { select: { name: true, heading: true, confirmedAt: true } } },
  });
  if (!server || server.legacyText || settingsOf(server).looksUp !== 'rightAway') return tools[0];
  const byName = new Map(server.tools.map((tool) => [tool.name.toUpperCase(), tool]));
  for (const name of tools) {
    const tool = byName.get(name.toUpperCase());
    if (!tool || !tool.confirmedAt || tool.heading !== 'looksUp') return name;
  }
  return null;
}
