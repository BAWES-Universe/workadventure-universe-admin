/**
 * What a Brick's computer can run on (build brief B, N1: the check before a paid wake).
 *
 * A computer's model calls go through the model relay, which speaks one wire format to the machine's agent. Whether a route can carry a computer
 * is known BEFORE anything is paid for: `startJob` asks here first and refuses with `unsupported` before it makes a machine, wakes one, reserves
 * room or writes a job, and the model relay's authorize answers `unsupported` for a step on a format that is not listed. Never after money moved.
 *
 * Today the list is the OpenAI chat format and the Gemini endpoints that speak it (`gemini-compatible`); a route in any other format (an owner's
 * own Claude key, native Anthropic format) is added here, by its own change, only once its adapter passes the comparison of transcripts. Until
 * then a Brick on such a route is refused here, clearly and for free.
 */
export const MODEL_FORMATS = ['openai', 'gemini-compatible', 'other'] as const;
export type ModelFormat = (typeof MODEL_FORMATS)[number];

/** The wire formats a computer can run on. The one place to add a format. */
export const COMPUTER_CAN_RUN: readonly ModelFormat[] = ['openai', 'gemini-compatible'];

/** A format that is not named is the one every route used before the field existed: OpenAI's. */
export const formatOf = (value: string | null | undefined): ModelFormat => (MODEL_FORMATS as readonly string[]).includes(value ?? '') ? (value as ModelFormat) : value === undefined || value === null ? 'openai' : 'other';

/** Whether a computer can run on a route of this format. */
export const computerCanRun = (value: string | null | undefined): boolean => COMPUTER_CAN_RUN.includes(formatOf(value));
