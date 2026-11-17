import { createHash } from 'crypto';

/**
 * Code jobs for Apps (the bounded "Workbench"): the words, rules and shapes, with no database in them so the executor, the link,
 * the sweep, the admin screen and the tests all read the same ones.
 *
 * A code job runs a short Python script in a temporary workspace at the provider (Composio's sandbox). What is, and is not, bounded:
 *
 *  - The workspace has NO App accounts, NO tools, NO raw-request proxy and NO connection tools (the job's provider session is made
 *    that way and read back to prove it). Data comes in as files Orbit puts there: what the Brick passed, and "reads" Orbit does
 *    itself with the person's own App link, one at a time, each counted like any App step. So nothing the code does can use the
 *    person's accounts, and nothing it does can be a second billable path.
 *  - It ends when the job's own deadline passes, when it is cancelled, or when its runs are used up, by DELETING the provider session
 *    (the provider shuts the workspace down and answers 404 to everything after). A client timeout alone never ends anything.
 *  - Files it leaves under out/ are copied into Universe's own storage before the provider's copy goes (a day at most).
 *  - NOT bounded by the provider: the workspace can reach the open internet, and the provider gives no way to narrow that. It holds
 *    nothing of the person's but what was put there.
 *
 * Every number is a Limit a super admin can change (never code). Money is in millionths of a dollar ("micros").
 */

export const CODE_JOB_PROVIDER = 'composio';

/** The provider's name for the tool that runs a cell of code, and for its sibling that runs a command. Neither is ever offered on an ordinary App link. */
export const SANDBOX_TOOLS: readonly string[] = ['COMPOSIO_REMOTE_WORKBENCH', 'COMPOSIO_REMOTE_BASH_TOOL'];
/** The provider's batch tool: one call that runs up to 50 others, which may include the two above. */
export const BATCH_TOOL = 'COMPOSIO_MULTI_EXECUTE_TOOL';

/** What the provider stops any one run of code at, by its own docs and a live check (17 Nov 2026): not a setting of ours. */
export const PROVIDER_CELL_SECONDS = 180;
/** A little longer than the provider's own stop, so its answer (a timed-out cell) is the one read, not our wait ending first. */
export const CELL_WAIT_GRACE_SECONDS = 15;

/** The tool names Orbit adds to an App link (they are Universe's, not the provider's). */
export const TOOL_START = 'UNIVERSE_CODE_JOB_START';
export const TOOL_RESULT = 'UNIVERSE_CODE_JOB_RESULT';
export const TOOL_CANCEL = 'UNIVERSE_CODE_JOB_CANCEL';
export const CODE_JOB_TOOLS: readonly string[] = [TOOL_START, TOOL_RESULT, TOOL_CANCEL];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// ---------- Limits ----------

export interface CodeJobLimits {
  /** The whole job: after this the workspace is deleted, whatever it was doing. */
  maxSeconds: number | null;
  /** Runs of code in one job (the provider stops any one run at 3 minutes). */
  maxCells: number | null;
  maxCodeBytes: number | null;
  /** Data put in the workspace: what was passed and what the reads brought. */
  maxInputBytes: number | null;
  /** Files kept from one job. */
  maxOutputBytes: number | null;
  maxOutputFiles: number | null;
  /** Characters of printed output sent back. */
  maxResultChars: number | null;
  /** App reads Orbit does for one job. */
  maxReads: number | null;
  atOncePerPerson: number | null;
  atOnceAll: number | null;
  jobsPerPersonPerDay: number | null;
  /** The most the provider's sandbox may cost us in a month (reservations and settled jobs together). It costs nothing today. */
  exposureCeilingMicros: number | null;
  /** Days a job's result and files are kept; empty keeps them until they are deleted. */
  keepDays: number | null;
  /** How long asking for a job's result waits before saying "still running". */
  waitSeconds: number | null;
}

export const CODE_JOB_LIMITS_EMPTY: CodeJobLimits = {
  maxSeconds: null,
  maxCells: null,
  maxCodeBytes: null,
  maxInputBytes: null,
  maxOutputBytes: null,
  maxOutputFiles: null,
  maxResultChars: null,
  maxReads: null,
  atOncePerPerson: null,
  atOnceAll: null,
  jobsPerPersonPerDay: null,
  exposureCeilingMicros: null,
  keepDays: null,
  waitSeconds: null,
};

export const CODE_JOB_LIMIT_RANGES: Record<keyof CodeJobLimits, { min: number; max: number }> = {
  maxSeconds: { min: 10, max: 3_600 },
  maxCells: { min: 1, max: 50 },
  maxCodeBytes: { min: 256, max: 1_048_576 },
  maxInputBytes: { min: 0, max: 524_288_000 },
  maxOutputBytes: { min: 0, max: 524_288_000 },
  maxOutputFiles: { min: 0, max: 200 },
  maxResultChars: { min: 100, max: 1_000_000 },
  maxReads: { min: 0, max: 20 },
  atOncePerPerson: { min: 1, max: 100 },
  atOnceAll: { min: 1, max: 10_000 },
  jobsPerPersonPerDay: { min: 1, max: 100_000 },
  exposureCeilingMicros: { min: 1, max: 1_000_000_000_000_000 },
  keepDays: { min: 1, max: 36_500 },
  // The bot server gives up on one call to an App link at 60 seconds, so a wait may never be that long
  waitSeconds: { min: 1, max: 55 },
};

/** Suggested starting values, shown beside each Limit and seeded by the migration. They are never read as an enforced value. */
export const CODE_JOB_LIMITS_RECOMMENDED: Partial<Record<keyof CodeJobLimits, number>> = {
  maxSeconds: 300,
  maxCells: 5,
  maxCodeBytes: 65_536,
  maxInputBytes: 10_485_760,
  maxOutputBytes: 26_214_400,
  maxOutputFiles: 10,
  maxResultChars: 20_000,
  maxReads: 3,
  atOncePerPerson: 1,
  atOnceAll: 3,
  jobsPerPersonPerDay: 20,
  exposureCeilingMicros: 1_000_000,
  keepDays: 30,
  waitSeconds: 40,
};

/** What each Limit is called and what it does, in the words the Limits screen shows. */
export const CODE_JOB_LIMIT_LABELS: Record<keyof CodeJobLimits, { label: string; help: string; unit: 'seconds' | 'count' | 'bytes' | 'micros' | 'days' }> = {
  maxSeconds: { label: 'Time for one job', help: 'After this many seconds the job is stopped and its workspace is deleted, whatever it was doing.', unit: 'seconds' },
  maxCells: { label: 'Runs of code in one job', help: 'How many separate runs of code one job may make. The provider stops any single run at 3 minutes.', unit: 'count' },
  maxCodeBytes: { label: 'Size of the code in one run', help: 'The most code one run may carry.', unit: 'bytes' },
  maxInputBytes: { label: 'Data put into a job', help: 'The most data a job may be given, counting what the Brick passes and what Orbit reads from the App for it.', unit: 'bytes' },
  maxOutputBytes: { label: 'Files kept from a job', help: 'The most file data kept from one job. Anything over it is not kept.', unit: 'bytes' },
  maxOutputFiles: { label: 'Number of files kept from a job', help: 'The most files kept from one job.', unit: 'count' },
  maxResultChars: { label: 'Printed output sent back', help: 'The most characters of what the code printed that are sent back to the Brick.', unit: 'count' },
  maxReads: { label: 'App reads for a job', help: 'How many App tools Orbit may run for one job, to bring data into it.', unit: 'count' },
  atOncePerPerson: { label: 'Jobs at once for one person', help: 'How many jobs one person may have running at the same time.', unit: 'count' },
  atOnceAll: { label: 'Jobs at once in all', help: 'How many jobs may be running at the same time across everyone.', unit: 'count' },
  jobsPerPersonPerDay: { label: 'Jobs a person may start in a day', help: 'A person asking for more waits until tomorrow.', unit: 'count' },
  exposureCeilingMicros: { label: 'Most code jobs may cost us in a month', help: 'The provider charges nothing for its workspace today. If that changes, new jobs stop at this amount for the month.', unit: 'micros' },
  keepDays: { label: 'Days a job is kept', help: 'How long a job’s result and files are kept before they are removed. Empty keeps them until the person deletes them.', unit: 'days' },
  waitSeconds: { label: 'How long to wait for a result', help: 'When the Brick asks for a result that is not ready, it waits this long before hearing "still running".', unit: 'seconds' },
};

/** Every Limit except "days kept" (empty keeps for good) is needed: a job does not start while one is empty, so nothing is ever assumed in code. */
export const CODE_JOB_NEEDED: (keyof CodeJobLimits)[] = (Object.keys(CODE_JOB_LIMIT_RANGES) as (keyof CodeJobLimits)[]).filter((key) => key !== 'keepDays');

const fitsRange = (value: unknown, range: { min: number; max: number }): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= range.min && value <= range.max;

/** Saved settings read back: each value that is there and fits, empty for the rest. */
export function readCodeJobLimits(saved: unknown): CodeJobLimits {
  const out: CodeJobLimits = { ...CODE_JOB_LIMITS_EMPTY };
  if (!isRecord(saved)) return out;
  for (const key of Object.keys(CODE_JOB_LIMIT_RANGES) as (keyof CodeJobLimits)[]) {
    if (fitsRange(saved[key], CODE_JOB_LIMIT_RANGES[key])) out[key] = saved[key] as number;
  }
  return out;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** A change to the Limits: only known names, each inside its range; null empties one again. */
export function checkCodeJobLimits(input: unknown): Checked<Partial<Record<keyof CodeJobLimits, number | null>>> {
  if (!isRecord(input)) return { ok: false, error: 'Expected an object' };
  const out: Partial<Record<keyof CodeJobLimits, number | null>> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.prototype.hasOwnProperty.call(CODE_JOB_LIMIT_RANGES, key)) return { ok: false, error: `Unknown setting: ${key}` };
    const name = key as keyof CodeJobLimits;
    if (value === null) {
      out[name] = null;
      continue;
    }
    if (!fitsRange(value, CODE_JOB_LIMIT_RANGES[name])) return { ok: false, error: `${key} must be a whole number from ${CODE_JOB_LIMIT_RANGES[name].min.toLocaleString('en')} to ${CODE_JOB_LIMIT_RANGES[name].max.toLocaleString('en')}` };
    out[name] = value;
  }
  return { ok: true, value: out };
}

export function missingCodeJobLimits(limits: CodeJobLimits): (keyof CodeJobLimits)[] {
  return CODE_JOB_NEEDED.filter((key) => limits[key] === null);
}

/** The Limits of a job as they were when it started (every needed one is there), or null when one is missing. */
export type FilledLimits = { [K in keyof CodeJobLimits]: K extends 'keepDays' ? number | null : number };

export function filledLimits(limits: CodeJobLimits): FilledLimits | null {
  return missingCodeJobLimits(limits).length > 0 ? null : (limits as FilledLimits);
}

// ---------- Keys and names ----------

/** The job key: the Brick and the bot server's own call id, so a retry is the same job. One that would not fit is made from a hash of both. */
export function codeJobKey(botId: string, callId: string): string {
  const whole = `codejob:${botId}:${callId.length}:${callId}`;
  return whole.length <= 255 ? whole : `codejob:${createHash('sha256').update(whole).digest('hex')}`;
}

/** The opaque id a job's provider session is made under, so the provider's log of it can be found and no person's id is ever sent. */
export const providerUserIdFor = (jobId: string): string => `codejob-${jobId}`;

export const sha256Hex = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** A file name that is safe inside the workspace and in storage: one plain name, no folders, no dots-only, no leading dot. */
export const isSafeFileName = (name: unknown): name is string => typeof name === 'string' && FILE_NAME.test(name) && !name.includes('..');

/** Where the files Orbit puts in the workspace live, and where the ones the code leaves behind are looked for. */
export const IN_DIR = 'in';
export const OUT_DIR = 'out';

const TYPES: Record<string, string> = {
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  html: 'text/html',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
};

/** The type a file is recorded and served as, from its name only (what the code says a file is is never trusted). */
export function contentTypeOf(name: string): string {
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(TYPES, extension) ? TYPES[extension] : 'application/octet-stream';
}

/** Whether a kept file is text a Brick can read in the answer as it is. */
export const isReadableText = (contentType: string): boolean => contentType.startsWith('text/') || contentType === 'application/json' || contentType === 'image/svg+xml';

export const clip = (text: string, max: number): { text: string; clipped: boolean } => (text.length <= max ? { text, clipped: false } : { text: text.slice(0, max), clipped: true });

// ---------- What the sandbox tools look like on an App link ----------

/** Whether a tool call on an ordinary App link would run the provider's sandbox: the tool itself, or a batch that holds it. Case does not matter. */
export function touchesSandbox(name: unknown, args: unknown): boolean {
  if (typeof name !== 'string') return false;
  const tool = name.trim().toUpperCase();
  if (SANDBOX_TOOLS.includes(tool)) return true;
  if (tool !== BATCH_TOOL) return false;
  const list = isRecord(args) ? args.tools : undefined;
  if (!Array.isArray(list)) return false;
  return list.some((entry) => {
    const slug = isRecord(entry) ? entry.tool_slug : undefined;
    return typeof slug === 'string' && SANDBOX_TOOLS.includes(slug.trim().toUpperCase());
  });
}

// ---------- A job's request ----------

export interface ReadRequest {
  tool: string;
  arguments: Record<string, unknown>;
  /** The file the answer is saved as in the workspace (under in/). */
  as: string;
}

export interface InputFile {
  name: string;
  /** Text, or base64 when `base64` is true. */
  content: string;
  base64: boolean;
}

export interface JobRequest {
  steps: string[];
  inputs: InputFile[];
  reads: ReadRequest[];
}

export type CodeJobReason =
  | 'not_set' // the Limits are not set yet
  | 'paused' // code jobs are stopped
  | 'not_owner' // only the Brick's owner's own requests run a job
  | 'bad_request' // the request is not one a job takes
  | 'not_allowed' // a read asks for an App tool that does not run right away for this Brick
  | 'too_big' // the code or the data is over a Limit
  | 'busy' // too many jobs running (for this person or in all)
  | 'daily_limit' // the person's jobs for the day are used
  | 'exposure_full' // the month's ceiling is reached
  | 'unavailable' // the provider cannot be used right now
  | 'read_failed' // an App read for the job did not work
  | 'code_failed' // the code ran and did not work
  | 'timed_out' // it ran out of time
  | 'cancelled' // it was cancelled
  | 'interrupted' // Orbit lost track of it and stopped it
  | 'not_found';

export const REASON_WORDS: Record<CodeJobReason, string> = {
  not_set: 'Code jobs are not available yet.',
  paused: 'Code jobs are paused for now.',
  not_owner: 'Only my owner can have me run code.',
  bad_request: 'That is not a request a code job takes.',
  not_allowed: 'I may not run that App tool right away, so a job cannot read with it.',
  too_big: 'That is bigger than a code job may be.',
  busy: 'Too many code jobs are running right now. Try again in a moment.',
  daily_limit: 'The code jobs for today are used up.',
  exposure_full: 'Code jobs are not available right now.',
  unavailable: 'Code jobs cannot run right now.',
  read_failed: 'I could not read the data from the App for the job.',
  code_failed: 'The code ran and did not work.',
  timed_out: 'The job ran out of time and was stopped.',
  cancelled: 'The job was cancelled.',
  interrupted: 'The job was stopped before it finished.',
  not_found: 'No such job.',
};

const MAX_STEPS_SAFETY = 50;

/**
 * The request a Brick sent, read strictly: `code` (one run) or `steps` (several, in order, in the same workspace), `inputs` (named files) and
 * `reads` (App tools Orbit runs for it). Anything else is refused, never guessed. Sizes are checked against the Limits the caller passes in.
 */
export type JobRequestRead = { ok: true; value: JobRequest } | { ok: false; reason: 'bad_request' | 'too_big'; error: string };
const bad = (error: string): JobRequestRead => ({ ok: false, reason: 'bad_request', error });
const big = (error: string): JobRequestRead => ({ ok: false, reason: 'too_big', error });

export function readJobRequest(args: unknown, limits: FilledLimits, toolkit: string | null): JobRequestRead {
  if (!isRecord(args)) return bad('The request must be an object.');
  const allowed = new Set(['code', 'steps', 'inputs', 'reads']);
  for (const key of Object.keys(args)) if (!allowed.has(key)) return bad(`Unknown field: ${key}`);

  let steps: string[];
  if (args.steps !== undefined) {
    if (args.code !== undefined) return bad('Send code or steps, not both.');
    if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > MAX_STEPS_SAFETY || args.steps.some((step) => typeof step !== 'string' || !step.trim())) return bad('steps must be a list of code strings.');
    steps = args.steps as string[];
  } else if (typeof args.code === 'string' && args.code.trim()) {
    steps = [args.code];
  } else return bad('Send the code to run.');
  if (steps.length > limits.maxCells) return bad(`A job may make ${limits.maxCells} runs of code at most.`);
  if (steps.some((step) => Buffer.byteLength(step, 'utf8') > limits.maxCodeBytes)) return big('The code or the data is over what a job may carry.');

  const inputs: InputFile[] = [];
  if (args.inputs !== undefined) {
    if (!Array.isArray(args.inputs) || args.inputs.length > 50) return bad('inputs must be a list of named files.');
    for (const entry of args.inputs) {
      if (!isRecord(entry) || !isSafeFileName(entry.name) || typeof entry.content !== 'string') return bad('Each input needs a plain file name and its content.');
      if (entry.base64 !== undefined && typeof entry.base64 !== 'boolean') return bad('base64 must be true or false.');
      inputs.push({ name: entry.name, content: entry.content, base64: entry.base64 === true });
    }
  }

  const reads: ReadRequest[] = [];
  if (args.reads !== undefined) {
    if (!Array.isArray(args.reads)) return bad('reads must be a list.');
    if (args.reads.length > limits.maxReads) return bad(`A job may read from the App ${limits.maxReads} times at most.`);
    const prefix = toolkit ? `${toolkit.toUpperCase()}_` : null;
    for (const [index, entry] of args.reads.entries()) {
      if (!isRecord(entry) || typeof entry.tool !== 'string') return bad('Each read needs the tool to run.');
      const tool = entry.tool.trim();
      // Only a tool of this App, and never one of the provider's own (its meta tools include the sandbox and batches)
      if (!/^[A-Za-z0-9_]{3,120}$/.test(tool) || tool.toUpperCase().startsWith('COMPOSIO_') || !prefix || !tool.toUpperCase().startsWith(prefix)) return bad('A read may only run a tool of this App.');
      if (entry.arguments !== undefined && !isRecord(entry.arguments)) return bad('A read’s arguments must be an object.');
      const as = entry.as === undefined ? `read-${index + 1}.json` : entry.as;
      if (!isSafeFileName(as)) return bad('A read’s file name must be a plain name.');
      reads.push({ tool, arguments: (entry.arguments as Record<string, unknown> | undefined) ?? {}, as });
    }
  }

  const names = [...inputs.map((input) => input.name), ...reads.map((read) => read.as)];
  if (new Set(names).size !== names.length) return bad('Two inputs have the same file name.');

  const inline = inputs.reduce((sum, input) => sum + (input.base64 ? Math.floor((input.content.length * 3) / 4) : Buffer.byteLength(input.content, 'utf8')), 0);
  if (inline > limits.maxInputBytes) return big('The code or the data is over what a job may carry.');
  return { ok: true, value: { steps, inputs, reads } };
}

/** What a job was allowed to do, as it is saved on the job. Read back, it says what the code could and could not reach. */
export function capabilitySet(request: JobRequest, toolkit: string | null) {
  return {
    version: 1,
    language: 'python',
    sandbox: 'standard',
    // The workspace's own provider session: no accounts, no tools, no raw requests, no connection tools, Instant off
    credentials: 'none',
    appTools: 'none',
    rawRequests: 'off',
    instant: 'off',
    // Data goes in as files; only these App tools of the one App link the job was asked through are run by Orbit, before the code
    reads: request.reads.map((read) => read.tool),
    readsApp: request.reads.length > 0 ? toolkit : null,
    files: { in: IN_DIR, out: OUT_DIR },
    // Stated plainly: the provider offers no way to narrow it
    network: 'provider-default',
  };
}
