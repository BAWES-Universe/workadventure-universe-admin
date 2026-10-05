import { z } from 'zod';

/**
 * How long a bot waits for a tool to answer, in seconds ("Patience" in the bot editor).
 * Null clears it, so the bot server's default (90 s) applies.
 */
export const toolTimeoutSecondsSchema = z
  .number()
  .int('toolTimeoutSeconds must be a whole number of seconds')
  .min(5, 'toolTimeoutSeconds must be at least 5')
  .max(600, 'toolTimeoutSeconds must be at most 600')
  .optional()
  .nullable();
