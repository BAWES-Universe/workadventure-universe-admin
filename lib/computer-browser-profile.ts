/**
 * STUB (piece 1 of the computer job controls). Piece 4 replaces this file with the real one: a paused job's browser sign-ins are put away where no other job and no agent can reach them,
 * brought back when it runs again, and dropped when it ends. Same names and arguments; each never throws.
 */
/** A job was paused while it held the machine (it ran or waited): its browser is put away for it alone. Only on an awake machine, never waking one. */
export async function parkProfile(_botId: string, _jobId: string): Promise<void> {}
/** A job that was paused is on the machine again: its own browser is put back (and the live one replaced, so it never inherits the browser of the job that ran in between). */
export async function restoreProfile(_botId: string, _jobId: string): Promise<void> {}
/** A job that was ever paused ended (in any way), or was cancelled: what was put away for it is dropped. */
export async function dropProfile(_botId: string, _jobId: string): Promise<void> {}
