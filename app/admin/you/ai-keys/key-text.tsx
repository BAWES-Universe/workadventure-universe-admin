/** Words and small pieces the AI keys page shares between text keys and voice keys. */

/** The names of a few bots: "Sam", "Guide and Nora", "Guide, Nora and Sam". */
export function names(list: string[]): string {
  return list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** Working or Down, as a small pill (green dot, or amber for Down). */
export function StatusPill({ down }: { down: boolean }) {
  return down ? (
    <span className="inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border border-[rgb(245_196_81/0.55)] px-2.5 text-[11px] font-semibold text-[#F5C451]" data-testid="ai-key-status">
      <i aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#F5C451]" />
      Down
    </span>
  ) : (
    <span className="inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border border-foreground/[.16] px-2.5 text-[11px] font-semibold" data-testid="ai-key-status">
      <i aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#4ade80]" />
      Working
    </span>
  );
}

export const DOWN_PHRASE = {
  stopped: 'stopped answering',
  rejected: 'didn’t accept the key',
  errors: 'kept failing',
  credit: 'is out of credit',
  model: 'no longer has the model',
} as const;

/** "2:14 PM", or "Oct 18, 2:14 PM" when it was not today. */
export function sinceText(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}
