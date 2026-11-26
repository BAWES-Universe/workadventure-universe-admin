import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { isOwnApp } from '@/lib/app-same';
import { acceptSorterPick, stricterHeading } from '@/lib/app-actions/sort';
import { lockGrant } from '@/lib/app-actions/grant';
import type { Heading, Setting } from '@/lib/mcp-tool-policy';

/**
 * A person's own App on their Brick is sorted and confirmed by Universe, the same way a ready-made App's actions are (#1042, lib/app-actions/sort.ts),
 * so their own Exa or Tavily runs as smoothly as any App and never waits for a review: no review gate on Apps, and own Apps never lose to a
 * ready-made copy for being the harder one to use (Khalid, 26 Nov 2026).
 *
 * Own here: an App the Brick's owner added by its link or from the list a super admin keeps, on their own Brick's grant. A key App (`kind: direct`) keeps its own agreed rule
 * (lib/app-direct/policy.ts: what we tested is confirmed, a custom operation waits for its owner), and Universe's GitHub keeps its own (game #2041).
 *
 * Each tool's heading:
 *  1. its name first: a name with a word that sends, replies, forwards, deletes, trashes, removes, pays, buys, publishes, shares or invites is
 *     Deletes or sends out, whatever else is said about it;
 *  2. else what the bot server suggested (the server's own labels, or the small model that reads descriptions), where Makes new things becomes
 *     Changes things (Universe knows of no private action of an App added by its link);
 *  3. no suggestion yet: Deletes or sends out, until a later read of the tools brings one.
 * Then the heading's setting decides (Looks things up and Makes new things Right away, Changes things and Deletes or sends out Asks first, unless
 * the person chose otherwise). Confirmed by Universe means no person: `confirmedById` stays empty.
 *
 * What a person decided is never lost: a tool a person confirmed or moved keeps their choice. A moved tool that changes sits under the
 * stricter of their heading and the rule for its new version, worked out from their own choice each time (keepMovedTool). A tool Universe
 * confirmed is sorted again when what it is sorted by changes (a suggestion that came later), and a tool that changed is sorted again like a
 * new one.
 */

/** Where one tool of an own App goes. */
export function sortOwnTool(name: string, suggested: Heading | null | undefined): Heading {
  return suggested ? acceptSorterPick('', wordsOf(name), suggested) : 'deletesOrSends';
}

// A tool of a link App may be named in camelCase ("sendMessage"): its words are split before the name is read, so a send is still a send
const wordsOf = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');

const SETTING_RANK: Record<Setting, number> = { rightAway: 0, asksFirst: 1, off: 2 };

/**
 * Where a tool a person moved sits once it changed: under whichever of the heading they chose and Universe's rule for the new version (its
 * name, then the server's suggestion; nothing suggested yet is Deletes or sends out) does the stricter thing with this grant's settings now
 * (Off, then Asks first, then Right away). A tie goes to the stricter heading. So a tool they moved under a heading set Off stays off, and it
 * is never looser than either. Worked out again from their own choice on every read of the list and every change of the settings, so a
 * suggestion that comes later brings their heading back.
 */
export function keepMovedTool(name: string, personHeading: Heading, suggested: Heading | null | undefined, settings: Record<Heading, Setting>): Heading {
  const rule = sortOwnTool(name, suggested);
  const person = SETTING_RANK[settings[personHeading]];
  const universe = SETTING_RANK[settings[rule]];
  if (person !== universe) return person > universe ? personHeading : rule;
  return stricterHeading(personHeading, rule);
}

/** The same wait as every other write of a grant's tools (GRANT_WRITE in lib/mcp-tool-policy.ts). */
const SETTLE_WRITE = { maxWait: 15_000, timeout: 60_000 } as const;

type Db = Prisma.TransactionClient | typeof prisma;

/** The grant is on its Brick owner's own App, added by its link or from the list (not a key App): Universe sorts and confirms its tools. */
export async function universeSortsTools(serverId: string, db: Db = prisma): Promise<boolean> {
  const server = await db.botMcpServer.findUnique({
    where: { id: serverId },
    select: { bot: { select: { ownerId: true, roomId: true } }, connection: { select: { source: true, kind: true, ownerId: true } } },
  });
  if (!server?.connection || server.connection.kind === 'direct' || !isOwnApp(server.connection)) return false;
  // Only the person's own App on their own Brick: an App lent to a universe, or a universe's own App, is confirmed as before by who manages its bots
  return server.bot.roomId === null && !!server.bot.ownerId && server.connection.ownerId === server.bot.ownerId;
}

/**
 * Sorts and confirms the tools of one grant when it is on the person's own App. Cheap when nothing is left to do. Returns true when a tool was
 * written (the policy revision went up with it, so a card or a remembered approval made before can be told apart).
 */
export async function settleOwnAppTools(serverId: string, db?: Prisma.TransactionClient): Promise<boolean> {
  const work = async (tx: Db) => {
    if (!(await universeSortsTools(serverId, tx))) return null;
    const server = await tx.botMcpServer.findUniqueOrThrow({
      where: { id: serverId },
      select: { legacyText: true, lookUpSetting: true, makeSetting: true, changeSetting: true, deleteSendSetting: true },
    });
    // A server that existed before tools were checked keeps working in text as it did: it is not changed under the person
    if (server.legacyText) return null;
    const settings = {
      looksUp: server.lookUpSetting,
      makesNew: server.makeSetting,
      changesThings: server.changeSetting,
      deletesOrSends: server.deleteSendSetting,
    } as Record<Heading, Setting>;
    const tools = await tx.botMcpTool.findMany({
      where: { serverId },
      select: { id: true, name: true, fingerprint: true, heading: true, personHeading: true, suggestedHeading: true, confirmedAt: true, confirmedById: true, movedById: true },
      orderBy: { id: 'asc' },
    });
    return tools.flatMap((tool) => {
      // A tool a person moved that Universe keeps for them since it changed (confirmed by nobody): worked out again from their own heading
      if (tool.movedById && !tool.confirmedById && tool.confirmedAt && tool.personHeading) {
        const heading = keepMovedTool(tool.name, tool.personHeading as Heading, tool.suggestedHeading as Heading | null, settings);
        return tool.heading === heading ? [] : [{ tool, heading, kept: true }];
      }
      // A person confirmed or moved it: theirs stays. The rest is written only where the sorted heading or the confirmation is missing
      if (tool.movedById || (tool.confirmedAt && tool.confirmedById)) return [];
      const heading = sortOwnTool(tool.name, tool.suggestedHeading as Heading | null);
      return tool.confirmedAt && tool.heading === heading ? [] : [{ tool, heading, kept: false }];
    });
  };
  const run = async (tx: Prisma.TransactionClient): Promise<boolean> => {
    // One writer of a grant's tools at a time: the grant is held first, as every other write of its tools does (lockGrant), so a read that
    // settles and a save of the list never take the same rows in two orders. Held twice in one write (a save that settles) is one hold.
    await lockGrant(tx, serverId);
    const todo = await work(tx);
    if (!todo || todo.length === 0) return false;
    const now = new Date();
    let written = 0;
    for (const { tool, heading, kept } of todo) {
      // Only the tool as it was read: a person's choice that landed in between wins, and this is left to the next look
      const done = kept
        ? await tx.botMcpTool.updateMany({
            where: { id: tool.id, fingerprint: tool.fingerprint, heading: tool.heading, personHeading: tool.personHeading, suggestedHeading: tool.suggestedHeading, confirmedById: null, movedById: tool.movedById },
            data: { heading },
          })
        : await tx.botMcpTool.updateMany({
            where: { id: tool.id, fingerprint: tool.fingerprint, heading: tool.heading, suggestedHeading: tool.suggestedHeading, confirmedAt: tool.confirmedAt, confirmedById: null, movedById: null },
            data: { heading, confirmedAt: now, confirmedById: null },
          });
      written += done.count;
    }
    if (written === 0) return false;
    await tx.botMcpServer.update({ where: { id: serverId }, data: { policyRevision: { increment: 1 } } });
    return true;
  };
  if (db) return run(db);
  // A read with nothing to do writes nothing and takes no lock
  const todo = await work(prisma);
  if (!todo || todo.length === 0) return false;
  // Held as long as a save of the list may hold the grant (GRANT_WRITE in lib/mcp-tool-policy.ts), so a read that waits for one does not fail
  return prisma.$transaction(run, SETTLE_WRITE);
}
