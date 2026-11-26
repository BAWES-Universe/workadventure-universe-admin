import { prisma } from '@/lib/db';
import { actionJudgeFor, slugKey, startingChoice, stricterSetting, type ActionJudge, type ActionVerdict } from '@/lib/app-actions/grant';
import { nameRule } from '@/lib/app-actions/sort';
import { settingsOf, type Heading, type Setting } from '@/lib/mcp-tool-policy';
import { GITHUB_ACTIONS, GITHUB_ACTIONS_KEY } from '@/lib/github/actions';

/**
 * What a Brick may do with each of its owner's GitHub actions, wherever Orbit runs one: the app link (chat and goals, behind the bot
 * server's gate), and the Brick's computer (git and opening a pull request, where nobody can be asked). A grant brought over to App actions
 * (lib/app-actions/grant.ts) is judged by its rows: each action's own choice, else its heading's. A grant not brought over yet (no reader that
 * knows App actions has read it) is judged by Universe's own sorting of GitHub and the grant's four headings, never looser than its own
 * rows judged a tool before, so every GitHub grant is judged the same way on Orbit's side from the start. Null when the Brick has no grant of this connection.
 */
export async function gitHubJudgeFor(botId: string, connectionId: string): Promise<ActionJudge | null> {
  const judge = await actionJudgeFor(botId, connectionId);
  if (judge) return judge;
  const grant = await prisma.botMcpServer.findFirst({
    where: { botId, connectionId },
    select: {
      appActionsVersion: true,
      lookUpSetting: true,
      makeSetting: true,
      changeSetting: true,
      deleteSendSetting: true,
      tools: { select: { name: true, heading: true, suggestedHeading: true, setting: true } },
    },
  });
  if (!grant) return null;
  // Brought over between the two reads: judged by its rows (and any choice a person has made since), never by what it was before
  if (grant.appActionsVersion !== null) return actionJudgeFor(botId, connectionId);
  const settings = settingsOf(grant);
  const byKey = new Map(GITHUB_ACTIONS.map((action) => [slugKey(action.slug), action]));
  // What the grant's own rows judged each tool by before (the bot server's list, under the heading a person or the bot server put it):
  // never looser than that, the same as when the grant is brought over (a tool under a heading set Off stays Off)
  const before = new Map<string, Setting>();
  for (const tool of grant.tools) {
    const heading = (tool.heading ?? tool.suggestedHeading) as Heading | null;
    const key = slugKey(tool.name);
    const judged = stricterSetting(heading ? settings[heading] : null, tool.setting as Setting | null);
    if (judged) before.set(key, stricterSetting(before.get(key) ?? null, judged)!);
  }
  return {
    toolkit: GITHUB_ACTIONS_KEY,
    knows: (slug) => byKey.has(slugKey(slug)),
    judge(slug: string): ActionVerdict {
      const key = slugKey(slug);
      const action = byKey.get(key);
      // An action Universe's list does not have: by its name, else the strictest heading
      const heading = action?.heading ?? nameRule(slug) ?? 'deletesOrSends';
      const now = action ? (startingChoice(GITHUB_ACTIONS_KEY, action.slug, settings[heading]) ?? settings[heading]) : settings[heading];
      return { slug, title: action?.title ?? slug, heading, setting: stricterSetting(now, before.get(key) ?? null)! };
    },
  };
}

/** The GitHub actions a step on a Brick's computer stands for. */
export const COMPUTER_ACTIONS = {
  /** Clone and fetch read the repository's files. */
  read: 'github_read_file',
  /** A push is one or more commits on a branch. */
  push: 'github_write_files',
  /** A push that makes a branch that was not there. */
  branch: 'github_create_branch',
  /** `open-pr` on the computer. */
  pullRequest: 'github_create_pull_request',
} as const;

export type ComputerStep = keyof typeof COMPUTER_ACTIONS;

const WHAT_STOPPED: Record<ComputerStep, string> = {
  read: "this computer can't read from GitHub",
  push: 'nothing was pushed',
  branch: 'nothing was pushed',
  pullRequest: 'no pull request was opened',
};

/**
 * Why each step may not run on the Brick's computer, or null when it may. A computer can't show its owner a card, so only Right away runs
 * there: Off and Asks first both stop the step, with words the Brick reads (git shows them as the remote's error) and passes on.
 */
export function computerStops(judge: ActionJudge, brick: string): Record<ComputerStep, string | null> {
  const stops = {} as Record<ComputerStep, string | null>;
  for (const step of Object.keys(COMPUTER_ACTIONS) as ComputerStep[]) {
    const verdict = judge.judge(COMPUTER_ACTIONS[step]);
    if (verdict.setting === 'rightAway') stops[step] = null;
    else if (verdict.setting === 'off') stops[step] = `${verdict.title} is off for ${brick} in GitHub, so ${WHAT_STOPPED[step]}.`;
    else stops[step] = `${verdict.title} asks first for ${brick} in GitHub, and a computer can't ask, so ${WHAT_STOPPED[step]}. Ask your owner in chat: ${verdict.title} there shows them a card.`;
  }
  return stops;
}
