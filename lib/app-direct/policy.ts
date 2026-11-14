import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db';
import { definitionSchema, hashDefinition, type Definition } from '@/lib/app-direct/definition';
import { headingOf } from '@/lib/app-direct/describe';

/**
 * A key app's operations as the tools of its grant (game #2044), so everything already built for tools works for it unchanged: the
 * bot server's gate (Right away, Asks first, Off per heading), the card that asks first, what a person confirmed and what they
 * remember, the review screen and the limit on how many a request may make.
 *
 *  - An operation we tested (`verified`) is confirmed under the heading it was classified under.
 *  - A custom operation waits to be confirmed. Until its owner confirms it, it asks first every time and nothing is remembered; once
 *    confirmed it follows its heading's setting.
 *  - The fingerprint holds the definition's version: when a definition changes, an operation's approval is gone and it waits again
 *    (a tested one is confirmed again by us, since we wrote it).
 */

/** The name the model calls an operation by: unique among a Brick's tools (a custom service says which of them with a few letters of its id). */
export function toolNameOf(definition: Pick<Definition, 'service' | 'short'>, operationId: string, connectionId: string): string {
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const parts = [slug(definition.short) || 'app', slug(operationId) || 'do'];
  if (definition.service === 'custom') parts.push(connectionId.replace(/[^a-z0-9]/gi, '').slice(0, 4).toLowerCase());
  return parts.join('_').slice(0, 64);
}

export const fingerprintOf = (definitionHash: string, operationId: string): string => createHash('sha256').update(`${definitionHash}:${operationId}`).digest('hex');

/** Makes the grant's tools match the definition it uses. Cheap when nothing changed. Returns true when something did. */
export async function ensureKeyAppTools(serverId: string): Promise<boolean> {
  const server = await prisma.botMcpServer.findUnique({ where: { id: serverId }, include: { connection: true, tools: { select: { id: true, name: true, fingerprint: true, confirmedAt: true } } } });
  const connection = server?.connection;
  if (!server || !connection || connection.kind !== 'direct' || !connection.definition) return false;
  const parsed = definitionSchema.safeParse(connection.definition);
  if (!parsed.success || hashDefinition(parsed.data) !== connection.definitionHash) return false;
  const definition = parsed.data;
  const hash = connection.definitionHash as string;
  const wanted = definition.operations.map((operation) => ({ operation, name: toolNameOf(definition, operation.id, connection.id), fingerprint: fingerprintOf(hash, operation.id) }));
  const byName = new Map(server.tools.map((tool) => [tool.name, tool]));
  const upToDate = wanted.length === server.tools.length && wanted.every((entry) => byName.get(entry.name)?.fingerprint === entry.fingerprint && (!entry.operation.verified || byName.get(entry.name)?.confirmedAt));
  if (upToDate) return false;

  await prisma.$transaction(async (tx) => {
    const now = new Date();
    for (const entry of wanted) {
      const heading = headingOf(entry.operation);
      const shown = { title: entry.operation.label.slice(0, 255), description: entry.operation.label.slice(0, 2000), suggestedHeading: heading, suggestionSource: 'builtIn' };
      // What we tested is confirmed by us, under the heading we classified it under; anything else waits for its owner
      const decided = entry.operation.verified ? { heading, confirmedAt: now, confirmedById: null, movedById: null } : { heading: null, confirmedAt: null, confirmedById: null, movedById: null };
      const before = byName.get(entry.name);
      if (!before) await tx.botMcpTool.create({ data: { serverId, name: entry.name, fingerprint: entry.fingerprint, ...shown, ...decided } });
      else if (before.fingerprint !== entry.fingerprint) await tx.botMcpTool.update({ where: { id: before.id }, data: { fingerprint: entry.fingerprint, ...shown, ...decided } });
      else if (entry.operation.verified && !before.confirmedAt) await tx.botMcpTool.update({ where: { id: before.id }, data: { ...shown, ...decided } });
    }
    const names = new Set(wanted.map((entry) => entry.name));
    const gone = server.tools.filter((tool) => !names.has(tool.name));
    if (gone.length > 0) await tx.botMcpTool.deleteMany({ where: { id: { in: gone.map((tool) => tool.id) } } });
    await tx.botMcpServer.update({ where: { id: serverId }, data: { legacyText: false, policyRevision: { increment: 1 } } });
  });
  return true;
}
