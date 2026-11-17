import { getAdapter } from '@/lib/app-adapter';
import { linkJson } from '@/lib/app-adapter/link-json';
import type { LinkAnswer } from '@/lib/app-adapter/types';
import { cancelCodeJob, getCodeJob, startCodeJob, type JobView, type ReadRunner } from '@/lib/workbench/executor';
import { getCodeJobLimits, getCodeJobPause } from '@/lib/workbench/state';
import { CODE_JOB_TOOLS, SANDBOX_TOOLS, TOOL_CANCEL, TOOL_RESULT, TOOL_START, filledLimits } from '@/lib/workbench/values';

/**
 * Code jobs on an App's link. The bot server only knows how to list an App's tools and call one, so a code job is offered the same way:
 * Orbit adds three tools of its own to the list an App gives, and answers them itself. Nothing is sent to the provider's sandbox through
 * the link: the provider's own two sandbox tools are taken out of every list and refused when called (alone or inside a batch), because
 * a run sent that way has no deadline, no Limits and no cancel, and its code could reach the person's accounts.
 *
 * The bot server gives up on a call to a link at 60 seconds, so starting a job answers at once and the result is asked for separately
 * (waiting at most "How long to wait for a result", which is kept under that).
 */

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const FILES = 'Files for the job go in /mnt/files/in/ (read) and /mnt/files/out/ (write; plain file names, no folders).';

/** The three tools, as they are listed to the Brick. The words are for the Brick: what it can and cannot rely on. */
export function codeJobTools(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  return [
    {
      name: TOOL_START,
      description:
        'Run a short Python script in a separate, temporary workspace, to transform or analyse data and to make files. It answers at once with a jobId; ask UNIVERSE_CODE_JOB_RESULT for the outcome. ' +
        'The workspace has no access to anyone’s Apps or accounts, so give it the data it needs: pass files in `inputs` (read them from /mnt/files/in/<name>), or ask for App data with `reads` (tools of this App, run for you and saved as /mnt/files/in/<as>). ' +
        `${FILES} Everything else in the workspace is deleted when the job ends. It stops at its time limit, and a job may make only a few runs of code (use \`steps\` to split longer work into runs that share the workspace; one run stops at 3 minutes). ` +
        'The workspace can reach the internet.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The Python to run. Send `code` or `steps`, not both.' },
          steps: { type: 'array', items: { type: 'string' }, description: 'Several runs of Python, in order, in the same workspace.' },
          inputs: {
            type: 'array',
            description: 'Files to put in the workspace.',
            items: {
              type: 'object',
              properties: { name: { type: 'string', description: 'A plain file name.' }, content: { type: 'string' }, base64: { type: 'boolean', description: 'True when content is base64 of binary data.' } },
              required: ['name', 'content'],
              additionalProperties: false,
            },
          },
          reads: {
            type: 'array',
            description: 'App tools to run before the code. Each answer is saved as a JSON file in /mnt/files/in/.',
            items: {
              type: 'object',
              properties: { tool: { type: 'string', description: 'A tool of this App.' }, arguments: { type: 'object' }, as: { type: 'string', description: 'The file name for the answer (default read-1.json, read-2.json, ...).' } },
              required: ['tool'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: TOOL_RESULT,
      description: 'Get the outcome of a code job: what the code printed, any problem, and the files it kept. If the job is still running this waits a short while, then says so; ask again.',
      inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'], additionalProperties: false },
    },
    {
      name: TOOL_CANCEL,
      description: 'Stop a code job that is still running. Its workspace is deleted.',
      inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'], additionalProperties: false },
    },
  ];
}

/** Whether code jobs can run at all right now: the provider side is there, every Limit is set and they are not paused. Never offered otherwise. */
export async function codeJobsAvailable(): Promise<boolean> {
  if (!getAdapter()?.workbench) return false;
  if (!filledLimits(await getCodeJobLimits())) return false;
  return !(await getCodeJobPause()).paused;
}

const reply = (id: unknown, body: Record<string, unknown>): LinkAnswer => ({
  status: 200,
  contentType: 'application/json',
  sessionId: null,
  body: JSON.stringify({ jsonrpc: '2.0', id: typeof id === 'number' || typeof id === 'string' ? id : null, ...body }),
});

const toolText = (id: unknown, value: unknown, isError: boolean): LinkAnswer => reply(id, { result: { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError } });

/** The answer to a call of the provider's own sandbox tool on an App link: refused, in words that point the Brick to the right tool. */
export const sandboxRefusal = (id: unknown): LinkAnswer =>
  toolText(id, `This App does not run code itself. To run code, use ${TOOL_START}.`, true);

/**
 * A tools/list answer from an App with the provider's sandbox tools taken out and the code job tools added (on the first page only, and only when
 * code jobs can run). An answer that cannot be read is passed on as it is (nothing is added), never turned into an error.
 */
export async function withCodeJobTools(answer: LinkAnswer, id: unknown, firstPage: boolean): Promise<LinkAnswer> {
  if (answer.status >= 400) return answer;
  const parsed = linkJson(answer.body, typeof id === 'number' || typeof id === 'string' ? id : undefined);
  if (!parsed || !isObject(parsed.result) || !Array.isArray((parsed.result as { tools?: unknown }).tools)) return answer;
  const result = parsed.result as { tools: unknown[] } & Record<string, unknown>;
  const kept = result.tools.filter((tool) => !(isObject(tool) && typeof tool.name === 'string' && SANDBOX_TOOLS.includes(tool.name.trim().toUpperCase())));
  const ours = firstPage && (await codeJobsAvailable()) ? codeJobTools() : [];
  const have = new Set(kept.map((tool) => (isObject(tool) && typeof tool.name === 'string' ? tool.name : '')));
  const tools = [...kept, ...ours.filter((tool) => !have.has(tool.name))];
  return { ...answer, contentType: 'application/json', body: JSON.stringify({ ...parsed, result: { ...result, tools } }) };
}

export interface CodeJobCall {
  botId: string;
  personId: string;
  connectionId: string;
  toolkit: string | null;
  name: string;
  args: unknown;
  callId: string;
  messageId: unknown;
  read: ReadRunner;
}

const OK_VIEW = (view: JobView) => view;

/** Answers one of the three tools. Every way it can end is an answer: a refusal is a tool result that says why, never an exception. */
export async function answerCodeJobCall(input: CodeJobCall): Promise<LinkAnswer> {
  const args = isObject(input.args) ? input.args : {};
  if (input.name === TOOL_START) {
    const outcome = await startCodeJob({ botId: input.botId, personId: input.personId, connectionId: input.connectionId, toolkit: input.toolkit, callId: input.callId, args: input.args ?? {}, read: input.read });
    if (outcome.status === 'refused') return toolText(input.messageId, { status: 'refused', reason: outcome.reason, message: outcome.message }, true);
    return toolText(input.messageId, { status: outcome.job.state, ...OK_VIEW(outcome.job), hint: outcome.job.state === 'running' ? `Ask ${TOOL_RESULT} with this jobId for the outcome.` : undefined }, false);
  }
  const jobId = typeof args.jobId === 'string' ? args.jobId : '';
  if (!jobId) return toolText(input.messageId, { status: 'refused', reason: 'bad_request', message: 'Send the jobId.' }, true);
  const outcome =
    input.name === TOOL_RESULT
      ? await getCodeJob({ jobId, botId: input.botId, personId: input.personId })
      : await cancelCodeJob({ jobId, botId: input.botId, personId: input.personId });
  if (outcome.status === 'refused') return toolText(input.messageId, { status: 'refused', reason: outcome.reason, message: outcome.message }, true);
  return toolText(input.messageId, { status: outcome.job.state, ...outcome.job }, false);
}

export const isCodeJobTool = (name: unknown): name is string => typeof name === 'string' && CODE_JOB_TOOLS.includes(name);
