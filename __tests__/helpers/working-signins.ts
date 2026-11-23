import type { ExecResult, FakeComputerProvider } from '@/lib/computer-provider';

/** What each sign-ins action prints when the machine did what it was asked (lib/computer-browser-profile-script.ts). */
const SAID: Record<string, string> = { park: 'parked', restore: 'restored', drop: 'dropped', clear: 'cleared', prune: 'pruned' };

/**
 * Makes a pretend computer answer the browser sign-ins command the way a WORKING machine does: it parks, brings back, drops, empties and
 * prunes what it is asked to. Without this the command answers nothing, which is a machine that will not do it: a paused job's browser is
 * never put away and never emptied, so (since GPT round 6, finding 7) nothing else starts on that machine and a job that carries on is left
 * `recover`. Use it in any suite that pauses and resumes jobs but is not itself about the browser; a suite that wants a machine that refuses
 * sets its own answer. Every other command keeps the answer it had.
 */
export function machineDoesSignIns(provider: FakeComputerProvider): void {
  const before = provider.execAnswer;
  provider.execAnswer = (command: string): Partial<ExecResult> | Promise<Partial<ExecResult>> => {
    const action = /^ACTION="([a-z]+)"$/m.exec(command)?.[1];
    return action && SAID[action] ? { stdout: `${SAID[action]}=1 cookies=0 pages=0\n` } : before(command);
  };
}
