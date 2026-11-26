import { prisma } from '@/lib/db';
import { actionJudgeFor, slugKey, type ActionJudge, type ActionVerdict } from '@/lib/app-actions/grant';
import { effectiveSetting, nameRule } from '@/lib/app-actions/sort';
import { settingsOf } from '@/lib/mcp-tool-policy';
import { GITHUB_ACTIONS, GITHUB_ACTIONS_KEY } from '@/lib/github/actions';

/**
 * What a Brick may do with each of its owner's GitHub actions, wherever Orbit runs one: the app link (chat and goals, behind the bot
 * server's gate), and the Brick's computer (git and opening a pull request, where nobody can be asked). A grant brought over to App actions
 * (lib/app-actions/grant.ts) is judged by its rows: each action's own choice, else its heading's. A grant not brought over yet (no reader that
 * knows App actions has read it) is judged by Universe's own sorting of GitHub and the grant's four headings, so every GitHub grant is
 * judged the same way on Orbit's side from the start. Null when the Brick has no grant of this connection.
 */
export async function gitHubJudgeFor(botId: string, connectionId: string): Promise<ActionJudge | null> {
  const judge = await actionJudgeFor(botId, connectionId);
  if (judge) return judge;
  const grant = await prisma.botMcpServer.findFirst({
    where: { botId, connectionId },
    select: { lookUpSetting: true, makeSetting: true, changeSetting: true, deleteSendSetting: true },
  });
  if (!grant) return null;
  const settings = settingsOf(grant);
  const byKey = new Map(GITHUB_ACTIONS.map((action) => [slugKey(action.slug), action]));
  return {
    toolkit: GITHUB_ACTIONS_KEY,
    knows: (slug) => byKey.has(slugKey(slug)),
    judge(slug: string): ActionVerdict {
      const action = byKey.get(slugKey(slug));
      // An action Universe's list does not have: by its name, else the strictest heading
      const heading = action?.heading ?? nameRule(slug) ?? 'deletesOrSends';
      return { slug, title: action?.title ?? slug, heading, setting: effectiveSetting(action?.startsOn ?? null, heading, settings) };
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
